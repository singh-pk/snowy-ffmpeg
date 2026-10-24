// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The video decode worker: decodes, with FFmpeg's `video` or `video-ext` module, the video
// streams WebCodecs does not, for the render worker (src/wasm-video.ts). FFmpeg decodes
// synchronously, in software, so it does so here, never in the render worker's animation
// frames. Each frame, in a format VideoFrame takes (sny_to_video_format), stays where the
// decoder left it in the module's shared memory, which the render worker uploads it from; the
// render worker sends it back once it is uploaded or dropped.

import {
  AVERROR_EAGAIN,
  AVERROR_EOF,
  createVideo,
  type VideoModule,
} from "@snowy-media/ffmpeg/video";
import type { FromVideo, ToVideo } from "./protocol";

type Ptr = number;
type Module = "video" | "video-ext";
// What waits in turn; a frame going back does not.
type Request = Exclude<ToVideo, { type: "release" }>;

const LOG_ERRORS = 16;
// The most planes a frame has: Y, Cb, Cr and alpha.
const MAX_PLANES = 4;
// Decoding threads: one a core, at most the module's pool of 8.
const THREADS = Math.min(navigator.hardwareConcurrency, 8);

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

// Whether a name is one of FORMATS. TypeScript's DOM types know fewer than Chromium takes.
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

// A decoder of stream parameters `params` in module `m`, `module`, posting its frames as decoder
// `id`.
function createDecoder(
  m: VideoModule,
  module: Module,
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

  // A view of all of memory. The module's HEAPU8 is not: the decoder's threads grow memory
  // as they allocate frames, and HEAPU8 follows only growth on this thread.
  const memory = { view: new Uint8Array(m.wasmMemory.buffer) };

  const heap = () => {
    const { buffer } = m.wasmMemory;
    if (memory.view.buffer !== buffer) memory.view = new Uint8Array(buffer);
    return memory.view;
  };

  const buf = m._malloc(params.length);
  heap().set(params, buf);
  const out = m._malloc(4);
  const opened = m._sny_decoder_open_params(buf, params.length, THREADS, out);
  const dec = new DataView(m.wasmMemory.buffer).getInt32(out, true);
  m._free(out);
  m._free(buf);
  check(opened, "decoder_open_params");
  const pkt = m._sny_packet_alloc();
  const frame = m._sny_frame_alloc();
  const sws = m._sny_scaler_alloc();

  function close() {
    m._sny_decoder_close(dec);
    m._sny_packet_free(pkt);
    m._sny_frame_free(frame);
    m._sny_scaler_free(sws);
  }

  if (!pkt || !frame || !sws) {
    close();
    throw new Error("decoder: out of memory");
  }

  function pixelFormat(held: Ptr) {
    const format = name(m._sny_frame_video_format(held));
    if (!isFormat(format)) throw new Error(`no VideoFrame format for ${format}`);
    return format;
  }

  // Where each plane of `held` starts in memory, and its stride; undefined if one is stored
  // bottom row first (a negative stride), as a texture is never uploaded. A format's unused
  // planes have no data.
  function planes(held: Ptr) {
    const layout: PlaneLayout[] = [];

    for (let i = 0; i < MAX_PLANES && m._sny_frame_data(held, i); i++) {
      const stride = m._sny_frame_linesize(held, i);
      if (stride <= 0) return undefined;
      layout.push({ offset: m._sny_frame_data(held, i), stride });
    }

    return layout;
  }

  // `held`, stored bottom row first, as a raw AVI's or a BMP's RGB is, packed top row first into
  // a buffer of its own, of `size` bytes, which stands for it from then on. Such a frame is RGB:
  // one plane, 4 bytes a pixel, `width` pixels a row.
  function pack(held: Ptr, size: number, width: number) {
    if (m._sny_frame_data(held, 1)) throw new Error("a planar frame stored bottom row first");
    const at = m._malloc(size);
    if (!at) throw new Error("malloc: out of memory");
    const packed = m._sny_frame_pack(held, at, size);

    if (packed < 0) {
      m._free(at);
      check(packed, "frame_pack");
    }

    m._sny_frame_free(held);
    return { frame: at, packed: true, layout: [{ offset: at, stride: width * 4 }] };
  }

  // The decoded frame, held in a reference of its own (or converted into a frame of its own) so
  // the decoder does not reuse its buffers before it goes back.
  function hold() {
    const held = m._sny_frame_alloc();
    if (!held) throw new Error("frame_alloc: out of memory");

    try {
      check(m._sny_to_video_format(sws, frame, held), "to_video_format");
      const width = m._sny_frame_width(held);
      const height = m._sny_frame_height(held);
      const [sarNum, sarDen] = [m._sny_frame_sar_num(frame), m._sny_frame_sar_den(frame)];
      // Non-square pixels widen or narrow it, as a WebCodecs decoder's display aspect does.
      const displayWidth = sarNum > 0 && sarDen > 0 ? Math.round((width * sarNum) / sarDen) : width;
      const format = pixelFormat(held);
      const size = check(m._sny_frame_pack_size(held), "frame_pack_size");
      const timestamp = micros(m._sny_frame_pts(frame));
      const layout = planes(held);
      // Last, as packing frees `held`.
      const kept = layout ? { frame: held, packed: false, layout } : pack(held, size, width);
      return {
        ...kept,
        format,
        codedWidth: width,
        codedHeight: height,
        displayWidth,
        timestamp,
        size,
      };
    } catch (e) {
      m._sny_frame_free(held);
      throw e;
    }
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
        if (got >= 0) post({ type: "frame", id, module, frame: hold() });
      }

      // Full, it takes the packet once its frames are out.
      if (sent !== AVERROR_EAGAIN) return;
    }
  }

  return {
    decode({ data, pts, dts, duration, flags }: Extract<Request, { type: "decode" }>) {
      const at = m._sny_packet_make(pkt, data.length, pts, dts, BigInt(duration), flags);
      if (!at) throw new Error("packet_make: out of memory");
      heap().set(data, at);
      decode(pkt);
    },
    flush: () => decode(0),
    close,
  };
}

type Decoder = ReturnType<typeof createDecoder>;

const modules = new Map<Module, Promise<VideoModule>>();
// The modules loaded, for a frame that goes back while a decoder waits for one to load.
const loaded = new Map<Module, VideoModule>();
// Open decoders by id; one that failed stays, without a decoder, until it closes.
const decoders = new Map<number, Decoder | undefined>();

async function handle(message: Request) {
  const { id } = message;

  if (message.type === "open") {
    if (!modules.has(message.module)) modules.set(message.module, load(message.module));
    const m = await modules.get(message.module);
    if (!m) return;
    loaded.set(message.module, m);
    decoders.set(id, createDecoder(m, message.module, id, message.params, message.timeBase));
    post({ type: "memory", id, memory: m.wasmMemory });
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
const inbox: Request[] = [];
const wake = { next: () => {} };

addEventListener("message", ({ data }: MessageEvent<ToVideo>) => {
  // At once, not behind the packets: its buffers go back to the decoder.
  if (data.type === "release") {
    const m = loaded.get(data.module);
    if (data.packed) m?._free(data.frame);
    else m?._sny_frame_free(data.frame);
    return;
  }

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
