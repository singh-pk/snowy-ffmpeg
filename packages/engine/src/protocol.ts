// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The messages between the engine on the main thread and its render worker.

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
