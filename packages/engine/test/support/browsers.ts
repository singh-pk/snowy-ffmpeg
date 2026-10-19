// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The three browsers with WebGPU on a GPU, for the tests and the benchmarks: headless Chromium
// uses the GPU only when told to, and Firefox has WebGPU only with a window
// (docs/architecture.md#testing).

import { type BrowserType, chromium, firefox, type LaunchOptions, webkit } from "playwright";

export const browsers: Record<string, [BrowserType, LaunchOptions]> = {
  chromium: [chromium, { args: ["--enable-gpu", "--ignore-gpu-blocklist"] }],
  firefox: [firefox, { headless: false }],
  webkit: [webkit, {}],
};
