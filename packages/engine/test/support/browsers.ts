// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Chromium with WebGPU on a GPU, for the tests and the benchmarks: headless, it uses the GPU
// only when told to (docs/architecture.md#testing).

import { chromium, type LaunchOptions } from "playwright";

// On a machine without a GPU, as CI's Windows and Linux runners, WebGPU renders in software
// with SNOWY_GPU: `swiftshader` on Linux, Chromium's software Vulkan, with ANGLE and the
// compositor on it too, without which a canvas cannot be read back nor a frame imported as an
// external texture; `warp` on Windows, its own software Direct3D 11, as Windows' Chromium has no
// SwiftShader Vulkan.
const ARGS: Record<string, string[]> = {
  "": ["--enable-gpu", "--ignore-gpu-blocklist"],
  swiftshader: [
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--use-gl=angle",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
  ],
  warp: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-webgpu-adapter=d3d11",
  ],
};
const gpu = process.env.SNOWY_GPU ?? "";
const args = ARGS[gpu];
if (!args) throw new Error(`SNOWY_GPU=${gpu}: not a GPU`);
const GPU: LaunchOptions = { args };

// Options replace the GPU ones: with them, Chromium keeps WebGPU on through
// --disable-features=WebGPU.
export const launch = (options: LaunchOptions = {}) => chromium.launch({ ...GPU, ...options });
