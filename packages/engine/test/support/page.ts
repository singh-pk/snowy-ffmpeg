// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Code for the test and benchmark pages, bundled by serve.ts and imported from PAGE: the
// packet ring and the hash test/fixtures/expected.json records for a stream's packets, and
// the audio output with a player that renders it offline.

import { AV_NOPTS_VALUE, AV_PKT_FLAG_KEY } from "@snowy-media/ffmpeg/core";
import { createAudioOutput } from "../../src/audio";
import { createPcmControl, createPcmRing } from "../../src/pcm";
import type { FromMedia, ToMedia } from "../../src/protocol";
import { createConsumer, createRing, END, FAILED } from "../../src/ring";
import { PCM_CHANNELS, PCM_RATE, probe } from "./audio";

export { createAudioOutput } from "../../src/audio";
export {
  createPcmConsumer,
  createPcmControl,
  createPcmProducer,
  createPcmRing,
} from "../../src/pcm";
export { createRing, RING_CAPACITY } from "../../src/ring";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// CRC-32 as zlib and ffprobe's -show_data_hash crc32 compute it.
function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 255] ?? 0) ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const timestamp = (t: bigint) => (t === AV_NOPTS_VALUE ? "" : String(t));

/**
 * Reads `ring` to its END record and resolves with each stream's packet count and the
 * SHA-256 of its lines `pts,dts,key,size,crc32`, without dts unless `dts`
 * (scripts/gen-fixtures.ts); or with "failed" at a FAILED record.
 */
export async function hashRing(ring: SharedArrayBuffer, dts: boolean) {
  const consumer = createConsumer(ring);
  const lines = new Map<number, string[]>();

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream === END) break;
    if (packet.stream === FAILED) return "failed";
    const { stream, flags, data } = packet;
    const key = flags & AV_PKT_FLAG_KEY ? 1 : 0;
    const times = dts ? `${timestamp(packet.pts)},${timestamp(packet.dts)}` : timestamp(packet.pts);
    const line = `${times},${key},${data.length},${crc32(data)}`;
    const all = lines.get(stream);
    if (all) all.push(line);
    else lines.set(stream, [line]);
    consumer.release();
  }

  const hashes: Record<number, { packets: number; packetsSha256: string }> = {};

  for (const [stream, all] of lines) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(all.join("\n")));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"));
    hashes[stream] = { packets: all.length, packetsSha256: hex.join("") };
  }

  return hashes;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * Plays audio stream `stream` of the file open in `media` through the engine's worklet (at
 * `worklet`) into an OfflineAudioContext of `seconds`, resampled to `channels` channels. The
 * ring holds `frames` frames, room for all of the audio, which is decoded before rendering
 * starts, so it underruns only at the end. Returns the media time of the first frame; the
 * clock's media time less its context time, at each poll while it runs; the clock at the
 * end; when channel 0 clicks, in context time; and, in stereo, the probe of what played
 * (test/support/audio.ts).
 */
export async function play(
  media: ReturnType<typeof startMedia>,
  stream: number,
  {
    worklet,
    seconds,
    channels,
    frames,
  }: Record<"seconds" | "channels" | "frames", number> & {
    worklet: string;
  },
) {
  const pcm = createPcmRing(2 ** Math.ceil(Math.log2(frames)), channels, PCM_RATE);
  const control = createPcmControl(pcm);
  const length = seconds * PCM_RATE;
  const context = new OfflineAudioContext({
    numberOfChannels: channels,
    length,
    sampleRate: PCM_RATE,
  });
  await createAudioOutput(context, pcm, worklet);
  // No packets: the ring only gets the END record.
  await media.request({ type: "demux", ring: createRing(64), streams: [], audio: { stream, pcm } });
  const offsets: number[] = [];
  const rendering = { done: false };

  async function poll() {
    while (!rendering.done) {
      const clock = control.read();
      if (clock.playing) offsets.push(clock.pts - clock.time);
      await tick();
    }
  }

  const polling = poll();
  const buffer = await context.startRendering();
  rendering.done = true;
  await polling;
  const { pts, playing } = control.read();
  const left = buffer.getChannelData(0);
  const clicks: number[] = [];

  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i] ?? 0) < 0.3) continue;
    clicks.push(i / PCM_RATE);
    i += PCM_RATE / 2;
  }

  const planes = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const probed =
    channels === PCM_CHANNELS
      ? probe(frames * channels, (i) => planes[i % channels]?.[Math.floor(i / channels)] ?? 0)
      : [];
  return { start: control.start(), offsets, end: { pts, playing }, clicks, probe: probed };
}

/** Starts the media worker at `url`, as a function per request; an error reply rejects. */
export function startMedia(url: string) {
  const worker = new Worker(url, { type: "module" });
  let next = 0;

  function request(message: DistributiveOmit<ToMedia, "id">) {
    const id = next++;

    return new Promise<FromMedia>((resolve, reject) => {
      worker.addEventListener("message", function reply(e: MessageEvent<FromMedia>) {
        if (e.data.id !== id) return;
        worker.removeEventListener("message", reply);
        if (e.data.type === "error") reject(new Error(e.data.message));
        else resolve(e.data);
      });
      worker.postMessage({ ...message, id });
    });
  }

  return { request, stop: () => worker.terminate() };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
