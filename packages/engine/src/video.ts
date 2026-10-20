// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Video output in the render worker: decodes a stream's packets from the packet ring with
// WebCodecs into the frame queue (src/frames.ts), and shows the frame due at a given media
// time through the compositor. Decoding waits while the queue is full or the decoder has
// enough packets in hand, so neither memory nor the decoder's backlog grows.

import { makesFrame, type VideoParams, videoConfig } from "./codec";
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

// A frame's bytes, or as an RGBA texture when the decoder keeps it on the GPU (no format).
const frameBytes = (frame: VideoFrame) =>
  frame.format ? frame.allocationSize() : frame.codedWidth * frame.codedHeight * 4;

/**
 * Decodes the packets of the stream with parameters `p` from `ring`, woken by `port`, and shows
 * them with `compositor`. `done` resolves once the decoder has decoded the last packet or the
 * output is closed, and rejects if decoding fails. `changed` runs on each event that may change
 * how far decoding is: a frame decoded, the decoder taking a packet, a wait for packets begun,
 * the end decoded, and the media worker blocking while `watch`ed.
 */
export function createVideoOutput(
  ring: SharedArrayBuffer,
  port: MessagePort,
  p: VideoParams,
  compositor: ReturnType<typeof createCompositor>,
  changed: () => void = () => {},
) {
  const consumer = createConsumer(ring, port, changed);
  const queue = createFrameQueue(FRAME_BUDGET, frameBytes);
  const [num, den] = p.timeBase;
  // Wakes the decode loop while it waits for room; replaced each time it waits.
  const wake = { room: () => {} };
  const state = {
    shown: undefined as VideoFrame | undefined,
    ended: false,
    // Waiting for a packet, the ring being empty.
    waiting: false,
    closed: false,
  };
  const decoding = createDecodeTracker();
  const failed = Promise.withResolvers<never>();
  const decoder = new VideoDecoder({
    output(frame) {
      decoding.out(frame.timestamp);
      // Out after a later frame went up, it could only take video back.
      if (state.shown && frame.timestamp <= state.shown.timestamp) frame.close();
      else queue.push(frame);
      changed();
    },
    error: failed.reject,
  });

  decoder.addEventListener("dequeue", () => {
    wake.room();
    changed();
  });

  const micros = (t: number) => Math.round((t * num * 1e6) / den);

  // Resolves at once while there is room, or else once a frame is shown, the decoder takes a
  // packet, or the output closes.
  async function room() {
    const woken = Promise.withResolvers<void>();
    wake.room = woken.resolve;
    if (queue.full() || decoder.decodeQueueSize >= DECODE_AHEAD) await woken.promise;
  }

  // Ends when the decoder has decoded the last packet, or at once when the output closes.
  async function run() {
    for (;;) {
      await room();
      if (state.closed) return;
      const packet = consumer.peek();

      if (!packet) {
        // Returns at once once the ring is closed, so the check above ends the loop.
        state.waiting = true;
        changed();
        await consumer.wait();
        state.waiting = false;
        continue;
      }

      if (packet.stream === END) break;
      if (packet.stream === FAILED) throw new Error("demuxing failed");
      if (decoder.state === "unconfigured") decoder.configure(videoConfig(p, packet.data));
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
    const frame = queue.take(time);
    if (!frame) return false;
    wake.room();
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
    close,
    /** The time, in microseconds, up to which every frame is decoded (src/decoding.ts). */
    decodedTo: decoding.decodedTo,
    /** Whether the decoder has decoded every packet. */
    ended: () => state.ended,
    /** Whether the frame queue is full, so decoding waits for a frame to be shown. */
    full: () => queue.full(),
    /** Whether it waits for packets with nothing left to decode. */
    starved: () => state.waiting && decoder.decodeQueueSize === 0,
    /** Whether the packet ring's producer waits for room. */
    blocked: () => consumer.producerWaiting(),
    /** Has `changed` run when the media worker next blocks; before reading whether it is. */
    watch: () => consumer.watch(),
  };
}
