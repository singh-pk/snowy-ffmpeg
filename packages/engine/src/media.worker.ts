// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The media worker: it reads the file and demuxes it with the FFmpeg core module, and decodes
// and resamples its audio. It is the one thread that may block, so it reads the file
// synchronously (src/io.ts) and waits for room in the packet ring (src/ring.ts) and the PCM
// ring (src/pcm.ts).

import {
  AV_NOPTS_VALUE,
  AV_TIME_BASE,
  AVERROR_EAGAIN,
  AVERROR_EOF,
  AVMEDIA_TYPE_ATTACHMENT,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_SUBTITLE,
  AVMEDIA_TYPE_VIDEO,
  type CoreModule,
  createCore,
  type Ptr,
} from "@snowy-media/ffmpeg/core";
import type { VideoParams } from "./codec";
import { createFileSource } from "./io";
import { createPcmProducer, pcmFormat } from "./pcm";
import { createProducer } from "./ring";
import type { FromMedia, MediaInfo, ToMedia, Track } from "./protocol";

// The kinds of the other streams; data and an unknown type (-1) are "data".
const OTHER = new Map([
  [AVMEDIA_TYPE_SUBTITLE, "subtitle"],
  [AVMEDIA_TYPE_ATTACHMENT, "attachment"],
] as const);
// Bytes per read: few reads, each one a slice of the file.
const BUFFER = 1 << 22;
// The worker reads one file at a time (src/io.ts), so its one input has a fixed id.
const IO = 1;

// Loading the module starts with the worker, before the first file arrives.
const ready = startMedia();

type AudioRequest = NonNullable<Extract<ToMedia, { type: "demux" }>["audio"]>;

// An audio stream being decoded into a PCM ring.
interface Audio {
  stream: number;
  decode(pkt: Ptr): boolean;
  end(): void;
  close(): void;
}

function post(message: FromMedia) {
  self.postMessage(message);
}

function createMedia(core: CoreModule) {
  const source = createFileSource(core);
  const str = (ptr: Ptr) => (ptr ? core.UTF8ToString(ptr) : "");
  // The open file's demuxer, or 0.
  const state = { ctx: 0 };
  const pkt = core._sny_packet_alloc();

  function check(ret: number, what: string) {
    if (ret < 0) throw new Error(`${what}: ${str(core._sny_strerror(ret))}`);
  }

  function track(id: number): Track {
    const st = core._sny_stream(state.ctx, id);
    const type = core._sny_codec_type(st);
    const codec = str(core._sny_codec_name(st));

    if (type === AVMEDIA_TYPE_VIDEO) {
      const [width, height] = [core._sny_codec_width(st), core._sny_codec_height(st)];
      return { id, kind: "video", codec, width, height };
    }

    if (type === AVMEDIA_TYPE_AUDIO) {
      const [sampleRate, channels] = [
        core._sny_codec_sample_rate(st),
        core._sny_codec_channels(st),
      ];
      return { id, kind: "audio", codec, sampleRate, channels };
    }

    return { id, kind: OTHER.get(type) ?? "data", codec };
  }

  // What a WebCodecs decoder config is made from (src/codec.ts).
  function videoParams(id: number): VideoParams {
    const st = core._sny_stream(state.ctx, id);
    const data = core._sny_codec_extradata(st);
    const tag = core._sny_codec_tag(st);
    return {
      codec: str(core._sny_codec_name(st)),
      // A little-endian four-character code, or 0.
      tag: tag
        ? String.fromCodePoint(tag & 255, (tag >>> 8) & 255, (tag >>> 16) & 255, tag >>> 24)
        : "",
      extradata: core.HEAPU8.slice(data, data + core._sny_codec_extradata_size(st)),
      width: core._sny_codec_width(st),
      height: core._sny_codec_height(st),
      level: core._sny_codec_level(st),
    };
  }

  function close() {
    if (state.ctx) core._sny_close(state.ctx);
    state.ctx = 0;
  }

  // Opens `file` in place of the open one and describes it, with its video streams'
  // parameters.
  function open(file: File): { info: MediaInfo; video: Record<number, VideoParams> } {
    close();
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(IO, BUFFER, name, out);
    const ctx = core.HEAP32[out >>> 2] ?? 0;
    core._free(name);
    core._free(out);
    check(opened, "open");
    state.ctx = ctx;
    check(core._sny_find_stream_info(ctx), "find_stream_info");
    const tracks = Array.from({ length: core._sny_nb_streams(ctx) }, (_, i) => track(i));
    const duration = core._sny_duration(ctx);
    const video: Record<number, VideoParams> = {};
    for (const t of tracks) if (t.kind === "video") video[t.id] = videoParams(t.id);
    // AV_NOPTS_VALUE, the only negative duration, is an unknown one.
    const info = {
      format: str(core._sny_format_name(ctx)),
      duration: duration < 0n ? undefined : Number(duration) / AV_TIME_BASE,
      tracks,
    };
    return { info, video };
  }

  // The open file's demuxer, after checking that `streams` are all streams of it.
  function demuxer(streams: number[]) {
    const { ctx } = state;
    if (!ctx) throw new Error("demux: no file is open");
    const count = core._sny_nb_streams(ctx);

    for (const s of streams) {
      if (!Number.isInteger(s) || s < 0 || s >= count)
        throw new RangeError(`demux: no stream ${s}`);
    }

    return ctx;
  }

  // Decodes audio stream `stream` into PCM ring `pcm`: `decode` takes each of its packets,
  // and returns false once the consumer has closed the ring; `end` drains the decoder and the
  // resampler. `close` frees it all.
  function createAudio(stream: number, pcm: SharedArrayBuffer): Audio {
    const ctx = demuxer([stream]);
    const st = core._sny_stream(ctx, stream);

    if (core._sny_codec_type(st) !== AVMEDIA_TYPE_AUDIO) {
      throw new RangeError(`demux: stream ${stream} is not audio`);
    }

    // Loading audio-ext for the long tail of codecs is still to come.
    const module = str(core._sny_codec_module(ctx, stream));
    if (!module) throw new Error(`demux: no module decodes stream ${stream}`);

    if (module !== "core") {
      throw new Error(`demux: stream ${stream} needs the ${module} module, not loaded yet`);
    }

    const { channels, rate } = pcmFormat(pcm);
    const producer = createPcmProducer(pcm);
    const [tbNum, tbDen] = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
    const frame = core._sny_frame_alloc();
    const resampled = core._sny_frame_alloc();
    const resampler = core._sny_resampler_alloc();
    const out = core._malloc(4);
    const allocated = frame && resampled && resampler && out;
    const opened = allocated ? core._sny_decoder_open(ctx, stream, out) : 0;
    const dec = allocated && opened >= 0 ? (core.HEAP32[out >>> 2] ?? 0) : 0;
    core._free(out);
    let started = false;

    function free() {
      core._sny_resampler_free(resampler);
      core._sny_frame_free(resampled);
      core._sny_frame_free(frame);
      if (dec) core._sny_decoder_close(dec);
    }

    if (!allocated || opened < 0) {
      free();
      if (!allocated) throw new Error("decoder: out of memory");
      check(opened, "decoder_open");
    }

    // Resamples `input` (0 at the end) into the ring; false once the ring is closed.
    function resample(input: Ptr) {
      check(core._sny_resample(resampler, input, resampled, rate, channels), "resample");
      const frames = core._sny_frame_samples(resampled);
      if (frames === 0) return true;
      const at = core._sny_frame_plane(resampled, 0) >>> 2;
      // HEAPF32 is read for each frame: the heap's buffer changes when memory grows.
      return producer.write(core.HEAPF32, at, frames);
    }

    function receive() {
      for (;;) {
        const ret = core._sny_decoder_receive(dec, frame);
        if (ret === AVERROR_EAGAIN || ret === AVERROR_EOF) return true;
        check(ret, "decoder_receive");

        if (!started) {
          const pts = core._sny_frame_pts(frame);
          producer.start(pts === AV_NOPTS_VALUE ? 0 : (Number(pts) * tbNum) / tbDen);
          started = true;
        }

        if (!resample(frame)) return false;
      }
    }

    // A packet the decoder rejects is skipped, as the ffmpeg command line does.
    function decode(packet: Ptr) {
      for (;;) {
        const ret = core._sny_decoder_send(dec, packet);
        if (!receive()) return false;
        if (ret !== AVERROR_EAGAIN) return true;
      }
    }

    function end() {
      if (decode(0)) resample(0);
    }

    return { stream, decode, end, close: free };
  }

  // Writes the packets of `streams` into `ring` and decodes those of `audio`, from where the
  // demuxer is to the end of the file, then drains the audio and writes the END record. Returns
  // early once the packet ring's consumer closes it; once the PCM ring's does, the audio stops
  // and the packets go on.
  function pump(ring: ReturnType<typeof createProducer>, streams: number[], audio?: Audio) {
    const ctx = demuxer(streams);
    let sound = audio;
    const selected = new Uint8Array(core._sny_nb_streams(ctx));
    for (const s of streams) selected[s] = 1;

    for (;;) {
      const ret = core._sny_read(ctx, pkt);
      if (ret === AVERROR_EOF) break;
      check(ret, "read");
      const stream = core._sny_packet_stream(pkt);

      if (stream === sound?.stream) {
        if (sound.decode(pkt)) continue;
        sound = undefined;
        // Nothing else to demux.
        if (streams.length === 0) break;
        continue;
      }

      if (!selected[stream]) continue;
      const pts = core._sny_packet_pts(pkt);
      const dts = core._sny_packet_dts(pkt);
      const duration = Number(core._sny_packet_duration(pkt));
      const data = core._sny_packet_data(pkt);
      const size = core._sny_packet_size(pkt);
      const flags = core._sny_packet_flags(pkt);
      // HEAPU8 is read for each packet: the heap's buffer changes when memory grows.
      if (!ring.write(stream, flags, pts, dts, duration, core.HEAPU8, data, size)) return;
    }

    sound?.end();
    ring.end();
  }

  // pump, and on an error the FAILED record, so the thread reading the ring stops too; the
  // error itself goes to whoever asked.
  function demux(ring: SharedArrayBuffer, streams: number[], audio?: AudioRequest) {
    const producer = createProducer(ring);
    let decoder: Audio | undefined;

    try {
      if (audio && streams.includes(audio.stream)) {
        throw new RangeError(`demux: stream ${audio.stream} is both demuxed and decoded`);
      }

      if (audio) decoder = createAudio(audio.stream, audio.pcm);
      pump(producer, streams, decoder);
    } catch (e) {
      producer.fail();
      throw e;
    } finally {
      decoder?.close();
    }
  }

  return { open, demux };
}

async function startMedia() {
  const core = await createCore();
  return createMedia(core);
}

async function handle(message: ToMedia) {
  const { id } = message;

  try {
    const media = await ready;

    if (message.type === "open") {
      post({ type: "opened", id, ...media.open(message.file) });
    } else {
      media.demux(message.ring, message.streams, message.audio);
      post({ type: "demuxed", id });
    }
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
}

// Registered at once: a message that arrives while the module loads waits for it in handle.
self.addEventListener("message", ({ data }: MessageEvent<ToMedia>) => void handle(data));
