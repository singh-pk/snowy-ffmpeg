// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Chromium with WebGPU on a GPU, for the tests and the benchmarks: headless, it uses the GPU
// only when told to (docs/architecture.md#testing).

import { chromium, type LaunchOptions } from "playwright";

// SNOWY_GPU=swiftshader: on a machine without one, as CI's Windows and Linux runners, WebGPU on
// SwiftShader, Chromium's software Vulkan, with ANGLE and the compositor on it too, without which
// a canvas cannot be read back nor a frame imported as an external texture.
const SWIFTSHADER = [
  "--enable-unsafe-webgpu",
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--use-gl=angle",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
];
const gpu = process.env.SNOWY_GPU ?? "";
if (gpu !== "" && gpu !== "swiftshader") throw new Error(`SNOWY_GPU=${gpu}: not a GPU`);
const GPU: LaunchOptions = {
  args: gpu === "swiftshader" ? SWIFTSHADER : ["--enable-gpu", "--ignore-gpu-blocklist"],
};

// Options replace the GPU ones: with them, Chromium keeps WebGPU on through
// --disable-features=WebGPU.
export const launch = (options: LaunchOptions = {}) => chromium.launch({ ...GPU, ...options });
