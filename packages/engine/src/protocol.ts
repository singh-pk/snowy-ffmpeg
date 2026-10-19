// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The messages between the engine on the main thread and its workers, and the types they
// carry that the public API shares.

import type { VideoParams } from "./codec";

/** A platform feature the engine needs (AGENTS.md rule 2). */
export type PlatformFeature =
  | "cross-origin-isolation"
  | "wasm-simd"
  | "wasm-threads"
  | "audio-worklet"
  | "offscreen-canvas"
  | "webgpu"
  | "webcodecs"
  | "webgpu-external-texture";

/** A missing feature, and what exactly was missing. */
export type Missing = [feature: PlatformFeature, reason: string];

// After init, the render worker plays video stream packets from `ring` (src/ring.ts), with
// parameters `params`, timed by the clock in PCM ring `pcm` (src/pcm.ts), until it stops. An
// error while it plays is reported once, with the play's `id`, and it stops. It says once
// when the first frame is decoded, so the main thread starts audio with video ready.
export type ToRender =
  | { type: "init"; canvas: OffscreenCanvas }
  | {
      type: "play";
      id: number;
      ring: SharedArrayBuffer;
      params: VideoParams;
      pcm: SharedArrayBuffer;
    }
  | { type: "stop" };

export type FromRender =
  | { type: "ready" }
  | { type: "unsupported"; missing: Missing }
  | { type: "decoded"; id: number }
  | { type: "error"; id: number; message: string };

/** A stream of a media file. `id` is its index in the file; `codec` is FFmpeg's codec name. */
export type Track =
  | { id: number; kind: "video"; codec: string; width: number; height: number }
  | { id: number; kind: "audio"; codec: string; sampleRate: number; channels: number }
  | { id: number; kind: "subtitle" | "data" | "attachment"; codec: string };

export interface MediaInfo {
  /** FFmpeg's names for the container format, such as "mov,mp4,m4a,3gp,3g2,mj2". */
  format: string;
  /** In seconds, unless the file does not say. */
  duration: number | undefined;
  tracks: Track[];
}

// `id` pairs each reply with its request. A demux request writes the packets of `streams`
// into `ring` (src/ring.ts), and with `audio` decodes that audio stream into the PCM ring
// `pcm` (src/pcm.ts), resampled to its rate and channels. It replies once it has written all
// the audio and the END record, or once a consumer has closed its ring. On an error it
// writes the FAILED record and replies with it.
export type ToMedia =
  | { type: "open"; id: number; file: File }
  | {
      type: "demux";
      id: number;
      ring: SharedArrayBuffer;
      streams: number[];
      audio?: { stream: number; pcm: SharedArrayBuffer };
    };

export type FromMedia =
  | { type: "opened"; id: number; info: MediaInfo; video: Record<number, VideoParams> }
  | { type: "demuxed"; id: number }
  | { type: "error"; id: number; message: string };
