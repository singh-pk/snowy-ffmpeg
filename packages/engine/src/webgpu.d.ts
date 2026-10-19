// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The WebGPU flag namespaces TypeScript's DOM and WebWorker libraries leave out, though they
// declare the rest of WebGPU; only the flags the engine and its tests use.

declare const GPUBufferUsage: {
  readonly MAP_READ: GPUFlagsConstant;
  readonly COPY_DST: GPUFlagsConstant;
  readonly UNIFORM: GPUFlagsConstant;
};

declare const GPUTextureUsage: {
  readonly COPY_SRC: GPUFlagsConstant;
  readonly RENDER_ATTACHMENT: GPUFlagsConstant;
};

declare const GPUMapMode: {
  readonly READ: GPUFlagsConstant;
};
