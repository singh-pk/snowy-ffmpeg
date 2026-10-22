// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Video output in the render worker: decodes a stream's packets from the packet ring with
// WebCodecs into the frame queue (src/frames.ts), and shows the frame due at a given media
// time through the compositor. Decoding waits while the queue is full, its frames are a
// second ahead of the media time, or the decoder has enough packets in hand, so neither memory nor the decoder's backlog grows.

import { isRasl, makesFrame, type VideoParams, videoConfig } from "./codec";
import type { createCompositor } from "./compositor";
import { createDecodeTracker } from "./decoding";
import { createFrameQueue } from "./frames";
import { createConsumer, END, FAILED, KEY_FLAG, NO_TIMESTAMP } from "./ring";

/**
 * The bytes of decoded frames the queue holds: enough for a few 4K 10-bit frames, and many
 * more of smaller ones (docs/architecture.md#frame-queue).
 */
const FRAME_BUDGET = 1 << 26;
// Packets handed to the decoder and not yet decoded.
const DECODE_AHEAD = 8;
// How far ahead of the media time shown, in microseconds, frames are decoded: the packets come
// far further ahead, and a decoder holding hundreds of frames stalls Firefox.
const TIME_AHEAD = 1_000_000;

// A frame's bytes, or as an RGBA texture when the decoder keeps it on the GPU (no format).
const frameBytes = (frame: VideoFrame) =>
  frame.format ? frame.allocationSize() : frame.codedWidth * frame.codedHeight * 4;

/**
 * Decodes the packets of the stream with parameters `p` from `ring`, woken by `port`, and shows
 * them with `compositor`. `done` resolves once the decoder has decoded the last packet or the
 * output is closed, and rejects if decoding fails. `changed` runs on each event that may change
 * how far decoding is: a frame decoded, the decoder taking a packet, a wait for packets or for
 * the media time begun, the end decoded, and the media worker blocking while `watch`ed. `freed`
 * runs as the ring frees room for a media worker that waits, and as it closes (src/ring.ts). It
 * plays from `from` (microseconds), its packets starting at a keyframe before it: of the frames
 * before, it keeps only the last, the one due then.
 */
export function createVideoOutput(
  ring: SharedArrayBuffer,
  port: MessagePort,
  p: VideoParams,
  compositor: ReturnType<typeof createCompositor>,
  changed: () => void = () => {},
  freed: () => void = () => {},
  from = 0,
) {
  const consumer = createConsumer(ring, port, changed, freed);
  const queue = createFrameQueue(FRAME_BUDGET, frameBytes);
  const [num, den] = p.timeBase;
  // Wakes the decode loop while it waits for room; replaced each time it waits.
  const wake = { room: () => {} };
  const state = {
    shown: undefined as VideoFrame | undefined,
    ended: false,
    // Waiting for a packet, the ring being empty.
    waiting: false,
    // The media time last shown, and the first frame's: decoding runs TIME_AHEAD past the later.
    at: -Infinity,
    first: -Infinity,
    // Waiting for the media time to reach the frames decoded.
    far: false,
    // Just past the first packet, where pictures that lead it are left out.
    leading: false,
    // Where it plays from, which a scrub moves on.
    from,
    closed: false,
  };
  const decoding = createDecodeTracker();
  const failed = Promise.withResolvers<never>();
  const decoder = new VideoDecoder({
    output(frame) {
      decoding.out(frame.timestamp);
      if (state.first === -Infinity) state.first = frame.timestamp;
      // Out after a later frame went up, it could only take video back.
      if (state.shown && frame.timestamp <= state.shown.timestamp) frame.close();
      else queue.push(frame);
      if (frame.timestamp < state.from) queue.drop(state.from);
      changed();
    },
    error: failed.reject,
  });

  decoder.addEventListener("dequeue", () => {
    wake.room();
    changed();
  });

  const micros = (t: number) => Math.round((t * num * 1e6) / den);
  const start = micros(p.start);

  // Whether every frame is decoded to TIME_AHEAD past the media time: measured from what the
  // decoder has let out, not its latest frame, so a frame it holds back is never cut off.
  const far = () => decoding.decodedTo() > Math.max(state.at, state.first) + TIME_AHEAD;

  // Resolves once there is room, or the output closes. It looks again on each wake (a frame
  // shown, the media time nearing the frames decoded, the decoder taking a packet): one wake
  // does not mean all have room.
  async function room() {
    for (;;) {
      if (state.closed) return;
      state.far = far();
      if (!state.far && !queue.full() && decoder.decodeQueueSize < DECODE_AHEAD) return;
      if (state.far) changed();
      const woken = Promise.withResolvers<void>();
      wake.room = woken.resolve;
      await woken.promise;
    }
  }

  // Ends when the decoder has decoded the last packet, or at once when the output closes.
  async function run() {
    for (;;) {
      await room();
      if (state.closed) return;
      const packet = consumer.peek();

      if (!packet) {
        // Closed by the main thread, as a seek or an open stops this play, no packet comes; a
        // wait would return at once, and again, starving the stop message behind it.
        if (consumer.closed()) return;
        state.waiting = true;
        changed();
        await consumer.wait();
        state.waiting = false;
        continue;
      }

      if (packet.stream === END) break;
      if (packet.stream === FAILED) throw new Error("demuxing failed");
      const first = decoder.state === "unconfigured";
      if (first) decoder.configure(videoConfig(p, packet.data));

      // Started at a CRA, as after a seek, the RASL pictures after it refer to pictures the
      // decoder never had.
      if (!first && state.leading && isRasl(p, packet.data)) {
        consumer.release();
        continue;
      }

      state.leading = first;
      // A missing pts takes the dts, right for a stream without B-frames. A raw stream with
      // them has neither and is not played yet.
      const pts = packet.pts === NO_TIMESTAMP ? packet.dts : packet.pts;
      if (pts === NO_TIMESTAMP) throw new Error("a video packet has no timestamp");
      // The chunk copies the data, so the packet is released at once.
      const chunk = new EncodedVideoChunk({
        type: packet.flags & KEY_FLAG ? "key" : "delta",
        timestamp: micros(Number(pts)),
        duration: micros(packet.duration),
        data: packet.data,
      });
      const dts = micros(Number(packet.dts === NO_TIMESTAMP ? pts : packet.dts));
      decoding.feed(chunk.timestamp, dts, makesFrame(p, packet.data));
      decoder.decode(chunk);
      consumer.release();
    }

    await decoder.flush();
    decoding.end();
    state.ended = true;
    changed();
  }

  async function finish() {
    try {
      await run();
    } catch (e) {
      // Closing aborts a flush or a decode in progress; that is no failure.
      if (!state.closed) throw e;
    }
  }

  const done = Promise.race([finish(), failed.promise]);

  /**
   * Shows the latest frame due at media time `time` (microseconds), if it is not already on
   * screen, and closes the frame it replaces. Whether a new frame went up.
   */
  function present(time: number) {
    state.at = time;
    // From a seek, nothing goes up until the frame due at its target is decoded: the frames
    // before it come first, and would flash by. Its end, as at a seek to the end, has them all.
    const sought = state.shown || state.ended || decoding.decodedTo() >= state.from;
    // Before the stream's first frame, as at a seek to the start of a file whose video starts
    // later, that frame stands for the time before it.
    const frame = sought ? queue.take(Math.max(time, start)) : undefined;
    // Waiting for the media time, only its nearing lets decoding on.
    if (state.far ? !far() : frame) wake.room();
    if (!frame) return false;
    const replaced = state.shown;
    // Owned before drawing, so a draw that throws leaves it for close.
    state.shown = frame;

    try {
      compositor.draw(frame, p.matrix);
    } finally {
      replaced?.close();
    }

    return true;
  }

  // Goes on to `to` (microseconds), later than where it plays from: the frames before it are
  // dropped as from a seek, and the latest due up to it goes up as it is decoded.
  function moveTo(to: number) {
    state.from = to;
    queue.drop(to);
  }

  /** Whether the frame due at `time` (microseconds) is the one on screen. */
  function reached(time: number) {
    return state.shown !== undefined && (state.ended || decoding.decodedTo() >= time);
  }

  /** Stops decoding and closes every frame. */
  function close() {
    state.closed = true;
    consumer.close();
    if (decoder.state !== "closed") decoder.close();
    queue.clear();
    state.shown?.close();
    state.shown = undefined;
    wake.room();
  }

  return {
    done,
    present,
    moveTo,
    reached,
    close,
    /** The time, in microseconds, up to which every frame is decoded (src/decoding.ts). */
    decodedTo: decoding.decodedTo,
    /** Whether the decoder has decoded every packet. */
    ended: () => state.ended,
    /** Whether the frame queue is full or far enough ahead, so decoding waits for the media time. */
    full: () => queue.full() || far(),
    /** Whether it waits for packets with nothing left to decode. */
    starved: () => state.waiting && decoder.decodeQueueSize === 0,
    /** Whether the packet ring's producer waits for room. */
    blocked: () => consumer.producerWaiting(),
    /** Has `changed` run when the media worker next blocks; before reading whether it is. */
    watch: () => consumer.watch(),
  };
}
