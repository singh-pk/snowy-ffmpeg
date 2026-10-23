// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The video decode worker: decodes, with FFmpeg's `video` or `video-ext` module, the video
// streams WebCodecs does not, for the render worker (src/wasm-video.ts). FFmpeg decodes
// synchronously, in software, so it does so here, never in the render worker's animation
// frames. Each frame becomes a VideoFrame, in a format
// VideoFrame takes (sny_to_video_format), with its colour, and is transferred.

import {
  AVERROR_EAGAIN,
  AVERROR_EOF,
  createVideo,
  type VideoModule,
} from "@snowy-media/ffmpeg/video";
import type { FromVideo, ToVideo } from "./protocol";

type Ptr = number;
type Module = "video" | "video-ext";

const LOG_ERRORS = 16;
// Decoding threads: one a core, at most the module's pool of 8.
const THREADS = Math.min(navigator.hardwareConcurrency, 8);

// FFmpeg's colour names, as VideoColorSpace names them; any other leaves it unstated.
// TypeScript's DOM types know fewer of these, and of the formats, than Chromium takes (PQ,
// HLG, BT.2020, 10 and 12 bits), so they are strings here, checked by the guards below.
const PRIMARIES: Record<string, string> = {
  bt709: "bt709",
  bt470bg: "bt470bg",
  smpte170m: "smpte170m",
  bt2020: "bt2020",
  smpte432: "smpte432",
};
const TRANSFERS: Record<string, string> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  "iec61966-2-1": "iec61966-2-1",
  linear: "linear",
  smpte2084: "pq",
  "arib-std-b67": "hlg",
};
const MATRICES: Record<string, string> = {
  gbr: "rgb",
  bt709: "bt709",
  bt470bg: "bt470bg",
  smpte170m: "smpte170m",
  bt2020nc: "bt2020-ncl",
};
// The formats sny_to_video_format makes.
const FORMATS = new Set([
  "I420",
  "I420P10",
  "I420P12",
  "I420A",
  "I420AP10",
  "I422",
  "I422P10",
  "I422P12",
  "I422A",
  "I422AP10",
  "I444",
  "I444P10",
  "I444P12",
  "I444A",
  "I444AP10",
  "NV12",
  "RGBA",
  "RGBX",
  "BGRA",
  "BGRX",
]);

// Whether a name is one of the maps' or FORMATS.
const isPrimaries = (v = ""): v is VideoColorPrimaries => Object.values(PRIMARIES).includes(v);
const isTransfer = (v = ""): v is VideoTransferCharacteristics =>
  Object.values(TRANSFERS).includes(v);
const isMatrix = (v = ""): v is VideoMatrixCoefficients => Object.values(MATRICES).includes(v);
const isFormat = (v: string): v is VideoPixelFormat => FORMATS.has(v);

function post(message: FromVideo, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

// Module `name`, loaded when a stream first needs it: video-ext only for the rarer codecs.
async function load(name: Module): Promise<VideoModule> {
  if (name === "video") {
    const m = await createVideo();
    m._sny_set_log_level(LOG_ERRORS);
    return m;
  }

  const { createVideoExt } = await import("@snowy-media/ffmpeg/video-ext");
  const m = await createVideoExt();
  m._sny_set_log_level(LOG_ERRORS);
  return m;
}

// A decoder of stream parameters `params` in module `m`, posting its frames as decoder `id`.
function createDecoder(
  m: VideoModule,
  id: number,
  params: Uint8Array,
  [num, den]: [number, number],
) {
  const check = (ret: number, what: string) => {
    if (ret < 0) throw new Error(`${what}: ${m.UTF8ToString(m._sny_strerror(ret))}`);
    return ret;
  };

  const name = (ptr: Ptr) => (ptr ? m.UTF8ToString(ptr) : "");
  // Rounded as src/video.ts rounds the packets' timestamps, so a frame's matches its packet's.
  const micros = (t: bigint) => Math.round((Number(t) * num * 1e6) / den);

  const buf = m._malloc(params.length);
  m.HEAPU8.set(params, buf);
  const out = m._malloc(4);
  const opened = m._sny_decoder_open_params(buf, params.length, THREADS, out);
  const dec = m.HEAP32[out >>> 2] ?? 0;
  m._free(out);
  m._free(buf);
  check(opened, "decoder_open_params");
  const pkt = m._sny_packet_alloc();
  const frame = m._sny_frame_alloc();
  const converted = m._sny_frame_alloc();
  const sws = m._sny_scaler_alloc();
  // Where frames are packed for a VideoFrame, grown as frames need.
  const packed = { at: 0, size: 0 };
  // The last frame's colour, which a stream keeps from frame to frame, and its colour space.
  const colour = { range: -1, primaries: -1, trc: -1, matrix: -1, space: {} };

  function close() {
    m._sny_decoder_close(dec);
    m._sny_packet_free(pkt);
    m._sny_frame_free(frame);
    m._sny_frame_free(converted);
    m._sny_scaler_free(sws);
    m._free(packed.at);
  }

  if (!pkt || !frame || !converted || !sws) {
    close();
    throw new Error("decoder: out of memory");
  }

  function colorSpace(): VideoColorSpaceInit {
    const range = m._sny_frame_color_range(converted);
    const primaries = m._sny_frame_color_primaries(converted);
    const trc = m._sny_frame_color_trc(converted);
    const matrix = m._sny_frame_color_space(converted);
    const c = colour;
    const same = range === c.range && primaries === c.primaries && trc === c.trc;
    if (same && matrix === c.matrix) return c.space;
    const space: VideoColorSpaceInit = {};
    const p = PRIMARIES[name(m._sny_color_primaries_name(primaries))];
    const t = TRANSFERS[name(m._sny_color_trc_name(trc))];
    const mc = MATRICES[name(m._sny_color_space_name(matrix))];
    const r = name(m._sny_color_range_name(range));
    if (isPrimaries(p)) space.primaries = p;
    if (isTransfer(t)) space.transfer = t;
    if (isMatrix(mc)) space.matrix = mc;
    if (r === "pc" || r === "tv") space.fullRange = r === "pc";
    Object.assign(colour, { range, primaries, trc, matrix, space });
    return space;
  }

  function pixelFormat() {
    const format = name(m._sny_frame_video_format(converted));
    if (!isFormat(format)) throw new Error(`no VideoFrame format for ${format}`);
    return format;
  }

  // Posts the decoded frame as a VideoFrame, packed out of the heap.
  function emit() {
    check(m._sny_to_video_format(sws, frame, converted), "to_video_format");
    const size = check(m._sny_frame_pack_size(converted), "frame_pack_size");

    if (size > packed.size) {
      m._free(packed.at);
      packed.at = m._malloc(size);
      packed.size = packed.at ? size : 0;
      if (!packed.at) throw new Error("malloc: out of memory");
    }

    check(m._sny_frame_pack(converted, packed.at, size), "frame_pack");
    const width = m._sny_frame_width(converted);
    const height = m._sny_frame_height(converted);
    const [sarNum, sarDen] = [m._sny_frame_sar_num(frame), m._sny_frame_sar_den(frame)];
    // Non-square pixels widen or narrow it, as a WebCodecs decoder's display aspect does.
    const displayWidth = sarNum > 0 && sarDen > 0 ? Math.round((width * sarNum) / sarDen) : width;
    const duration = m._sny_frame_duration(frame);
    // VideoFrame copies the data, so the buffer is packed into again for the next frame.
    const picture = new VideoFrame(m.HEAPU8.subarray(packed.at, packed.at + size), {
      format: pixelFormat(),
      codedWidth: width,
      codedHeight: height,
      displayWidth,
      displayHeight: height,
      timestamp: micros(m._sny_frame_pts(frame)),
      ...(duration > 0n ? { duration: micros(duration) } : {}),
      colorSpace: colorSpace(),
    });
    post({ type: "frame", id, frame: picture }, [picture]);
  }

  // Sends `packet` (0 to drain) and posts every frame it completes. A packet the decoder
  // rejects, or a frame it fails to decode, is skipped, as the ffmpeg command line does: with
  // frame threads, a broken packet's error comes out of receive.
  function decode(packet: Ptr) {
    for (;;) {
      const sent = m._sny_decoder_send(dec, packet);

      for (;;) {
        const got = m._sny_decoder_receive(dec, frame);
        if (got === AVERROR_EAGAIN || got === AVERROR_EOF) break;
        if (got >= 0) emit();
      }

      // Full, it takes the packet once its frames are out.
      if (sent !== AVERROR_EAGAIN) return;
    }
  }

  return {
    decode({ data, pts, dts, duration, flags }: Extract<ToVideo, { type: "decode" }>) {
      const at = m._sny_packet_make(pkt, data.length, pts, dts, BigInt(duration), flags);
      if (!at) throw new Error("packet_make: out of memory");
      m.HEAPU8.set(data, at);
      decode(pkt);
    },
    flush: () => decode(0),
    close,
  };
}

type Decoder = ReturnType<typeof createDecoder>;

const modules = new Map<Module, Promise<VideoModule>>();
// Open decoders by id; one that failed stays, without a decoder, until it closes.
const decoders = new Map<number, Decoder | undefined>();

async function handle(message: ToVideo) {
  const { id } = message;

  if (message.type === "open") {
    if (!modules.has(message.module)) modules.set(message.module, load(message.module));
    const m = await modules.get(message.module);
    if (!m) return;
    decoders.set(id, createDecoder(m, id, message.params, message.timeBase));
    return;
  }

  const decoder = decoders.get(id);

  if (message.type === "close") {
    decoder?.close();
    decoders.delete(id);
  } else if (message.type === "decode") {
    decoder?.decode(message);
    post({ type: "decoded", id, flushed: false });
  } else {
    decoder?.flush();
    post({ type: "decoded", id, flushed: true });
  }
}

// Messages are handled one at a time, in order: an open waits for its module, and the packets
// sent behind it wait for the decoder.
const inbox: ToVideo[] = [];
const wake = { next: () => {} };

addEventListener("message", ({ data }: MessageEvent<ToVideo>) => {
  inbox.push(data);
  wake.next();
});

async function serve() {
  for (;;) {
    const message = inbox.shift();

    if (!message) {
      const next = Promise.withResolvers<void>();
      wake.next = next.resolve;
      await next.promise;
      continue;
    }

    try {
      await handle(message);
    } catch (e) {
      // It decodes nothing more, but stays until it closes.
      decoders.get(message.id)?.close();
      decoders.set(message.id, undefined);
      post({ type: "error", id: message.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
}

void serve();
