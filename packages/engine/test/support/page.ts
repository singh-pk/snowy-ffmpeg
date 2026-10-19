// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Code for the test and benchmark pages, bundled by serve.ts and imported from PAGE: the
// packet ring and the hash test/fixtures/expected.json records for a stream's packets, and
// the audio output with a player that renders it offline; and a video stream's first packet
// and the check of its decoder config.

import { AV_NOPTS_VALUE, AV_PKT_FLAG_KEY } from "@snowy-media/ffmpeg/core";
import { createAudioOutput } from "../../src/audio";
import { type VideoParams, videoConfig } from "../../src/codec";
import { createPcmControl, createPcmRing } from "../../src/pcm";
import type { FromMedia, ToMedia } from "../../src/protocol";
import { createConsumer, createRing, END, FAILED } from "../../src/ring";
import { PCM_CHANNELS, PCM_RATE, probe } from "./audio";
import { readFrameId } from "./frame-id";

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

/** The first packet of `stream` in the file open in `media`, which stops demuxing after it. */
export async function firstPacket(media: ReturnType<typeof startMedia>, stream: number) {
  const ring = createRing(1 << 22);
  const consumer = createConsumer(ring);
  const demuxed = media.request({ type: "demux", ring, streams: [stream] });

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream !== stream) throw new Error(`no packet of stream ${stream}`);
    const data = packet.data.slice();
    consumer.close();
    await demuxed;
    return data;
  }
}

// The keyframe `packet` of a stream with parameters `p` as a stream without a configuration
// record carries it: for H.264 and HEVC in Annex B, each NAL unit after a start code instead
// of its length, behind the record's parameter sets. avcC: 4 bytes, the length size, the SPS
// count, each SPS with its size, the PPS count, each PPS with its size. hvcC: 21 bytes, the
// length size, then arrays of NAL units. AV1, VP8 and VP9 packets are already the same.
function inBand(p: VideoParams, packet: Uint8Array) {
  const d = p.extradata;
  const units: Uint8Array[] = [];
  const u16 = (at: number) => ((d[at] ?? 0) << 8) | (d[at + 1] ?? 0);
  let lengthSize = 0;

  if (p.codec === "h264" && d[0] === 1) {
    lengthSize = ((d[4] ?? 0) & 3) + 1;
    let at = 5;

    for (const mask of [31, 255]) {
      const count = (d[at++] ?? 0) & mask;

      for (let i = 0; i < count; i++) {
        units.push(d.subarray(at + 2, at + 2 + u16(at)));
        at += 2 + u16(at);
      }
    }
  } else if (p.codec === "hevc" && d.length >= 23) {
    lengthSize = ((d[21] ?? 0) & 3) + 1;
    let at = 23;

    for (let a = 0; a < (d[22] ?? 0); a++) {
      const count = u16(at + 1);
      at += 3;

      for (let i = 0; i < count; i++) {
        units.push(d.subarray(at + 2, at + 2 + u16(at)));
        at += 2 + u16(at);
      }
    }
  }

  if (!lengthSize) return packet;

  for (let at = 0; at + lengthSize <= packet.length;) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + (packet[at + i] ?? 0);
    units.push(packet.subarray(at + lengthSize, at + lengthSize + size));
    at += lengthSize + size;
  }

  const out: number[] = [];
  for (const unit of units) out.push(0, 0, 0, 1, ...unit);
  return new Uint8Array(out);
}

// The frame number (test/support/frame-id.ts) of the frame a decoder configured with
// `config` decodes from `keyframe`.
async function decodeFrameId(config: VideoDecoderConfig, keyframe: Uint8Array) {
  const decoded = Promise.withResolvers<VideoFrame>();
  const decoder = new VideoDecoder({ output: decoded.resolve, error: decoded.reject });
  decoder.configure(config);
  decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: keyframe }));
  const flushed = decoder.flush();
  const frame = await decoded.promise;
  await flushed;
  decoder.close();
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2D context");
  context.drawImage(frame, 0, 0);
  frame.close();
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return readFrameId(data, canvas.width * 4, 4);
}

/**
 * The decoder config of a stream with parameters `p` and first packet `keyframe`, whether
 * the browser's VideoDecoder takes it, and if it does, the frame number of the frame it
 * decodes; and the same for the stream as it would be without a configuration record, its
 * parameter sets in band.
 */
export async function checkVideoConfig(p: VideoParams, keyframe: Uint8Array) {
  const config = videoConfig(p, keyframe);
  const inBandKeyframe = inBand(p, keyframe);
  const inBandConfig = videoConfig({ ...p, extradata: new Uint8Array() }, inBandKeyframe);
  const { supported = false } = await VideoDecoder.isConfigSupported(config);
  const result = { codec: config.codec, inBandCodec: inBandConfig.codec, supported };
  if (!supported) return { ...result, id: undefined, inBandId: undefined };
  const id = await decodeFrameId(config, keyframe);
  const inBandId = await decodeFrameId(inBandConfig, inBandKeyframe);
  return { ...result, id, inBandId };
}
