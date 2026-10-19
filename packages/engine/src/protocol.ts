// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The messages between the engine on the main thread and its workers, and the types they
// carry that the public API shares.

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

export type ToRender = { type: "init"; canvas: OffscreenCanvas };

export type FromRender = { type: "ready" } | { type: "unsupported"; missing: Missing };

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

// `id` pairs each reply with its request.
export type ToMedia = { type: "open"; id: number; file: File };

export type FromMedia =
  | { type: "opened"; id: number; info: MediaInfo }
  | { type: "error"; id: number; message: string };
