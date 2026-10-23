// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Chromium with WebGPU on a GPU, for the tests and the benchmarks: headless, it uses the GPU
// only when told to (docs/architecture.md#testing).

import { chromium, type LaunchOptions } from "playwright";

const GPU: LaunchOptions = { args: ["--enable-gpu", "--ignore-gpu-blocklist"] };

// Options replace the GPU ones: with them, Chromium keeps WebGPU on through
// --disable-features=WebGPU.
export const launch = (options: LaunchOptions = {}) => chromium.launch({ ...GPU, ...options });
