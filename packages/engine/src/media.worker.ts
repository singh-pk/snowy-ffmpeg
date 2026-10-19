// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The media worker: it reads the file and demuxes it with the FFmpeg core module. It is the
// one thread that may block, so it reads the file synchronously (src/io.ts).

import {
  AV_TIME_BASE,
  AVMEDIA_TYPE_ATTACHMENT,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_SUBTITLE,
  AVMEDIA_TYPE_VIDEO,
  type CoreModule,
  createCore,
  type Ptr,
} from "@snowy-media/ffmpeg/core";
import { createFileSource } from "./io";
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

function post(message: FromMedia) {
  self.postMessage(message);
}

function createMedia(core: CoreModule) {
  const source = createFileSource(core);
  const str = (ptr: Ptr) => (ptr ? core.UTF8ToString(ptr) : "");
  // The open file's demuxer, or 0.
  const state = { ctx: 0 };

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

  function close() {
    if (state.ctx) core._sny_close(state.ctx);
    state.ctx = 0;
  }

  // Opens `file` in place of the open one and describes it.
  function open(file: File): MediaInfo {
    close();
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(IO, BUFFER, name, out);
    const ctx = core.HEAP32[out >> 2] ?? 0;
    core._free(name);
    core._free(out);
    check(opened, "open");
    state.ctx = ctx;
    check(core._sny_find_stream_info(ctx), "find_stream_info");
    const tracks = Array.from({ length: core._sny_nb_streams(ctx) }, (_, i) => track(i));
    const duration = core._sny_duration(ctx);
    // AV_NOPTS_VALUE, the only negative duration, is an unknown one.
    return {
      format: str(core._sny_format_name(ctx)),
      duration: duration < 0n ? undefined : Number(duration) / AV_TIME_BASE,
      tracks,
    };
  }

  return { open };
}

async function startMedia() {
  const core = await createCore();
  return createMedia(core);
}

async function handle({ id, file }: ToMedia) {
  try {
    const media = await ready;
    post({ type: "opened", id, info: media.open(file) });
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
}

// Registered at once: a message that arrives while the module loads waits for it in handle.
self.addEventListener("message", ({ data }: MessageEvent<ToMedia>) => void handle(data));
