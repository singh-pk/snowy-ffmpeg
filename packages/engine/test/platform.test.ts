// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// createEngine's platform check in Chromium, Firefox and WebKit: it starts where the baseline
// is met, and names the missing feature where it is not. Usage: bun run test.

import { afterAll, describe, expect, test } from "bun:test";
import {
  type BrowserType,
  chromium,
  firefox,
  type LaunchOptions,
  type Page,
  webkit,
} from "playwright";
import { serve } from "../../../tooling/test-server";

const root = new URL("../", import.meta.url);
const page = "<!doctype html><title>test</title>";
const isolated = serve(root, page);
const notIsolated = serve(root, page, { isolated: false });

afterAll(async () => {
  await isolated.stop(true);
  await notIsolated.stop(true);
});

// WebGPU on, with a real GPU: headless Chromium uses the GPU only when told to, and Firefox
// has WebGPU only with a window.
const browsers: [string, BrowserType, LaunchOptions][] = [
  ["chromium", chromium, { args: ["--enable-gpu", "--ignore-gpu-blocklist"] }],
  ["firefox", firefox, { headless: false }],
  ["webkit", webkit, {}],
];

// The same browsers with WebGPU turned off, where a switch exists.
const withoutWebGPU: [string, BrowserType, LaunchOptions][] = [
  ["chromium", chromium, { args: ["--disable-features=WebGPU"] }],
  ["firefox", firefox, { headless: false, firefoxUserPrefs: { "dom.webgpu.enabled": false } }],
];

// Opens `url` in a fresh browser and starts an engine: "ok", or the feature it names missing.
async function start(type: BrowserType, options: LaunchOptions, url: URL) {
  const browser = await type.launch(options);

  try {
    const tab: Page = await browser.newPage();
    await tab.goto(url.href);

    return await tab.evaluate(async (entry) => {
      const engine: typeof import("../src/index") = await import(entry);

      try {
        const started = await engine.createEngine({ canvas: document.createElement("canvas") });
        started.close();
        return "ok";
      } catch (e) {
        return e instanceof engine.UnsupportedPlatformError ? e.feature : String(e);
      }
    }, "/dist/index.js");
  } finally {
    await browser.close();
  }
}

for (const [name, type, options] of browsers) {
  describe(name, () => {
    test("starts on a cross-origin isolated page", async () => {
      const result = await start(type, options, isolated.url);
      expect(result).toBe("ok");
    }, 60_000);

    test("names cross-origin isolation when the page lacks it", async () => {
      const result = await start(type, options, notIsolated.url);
      expect(result).toBe("cross-origin-isolation");
    }, 60_000);
  });
}

for (const [name, type, options] of withoutWebGPU) {
  test(`${name}: names WebGPU when it is off`, async () => {
    const result = await start(type, options, isolated.url);
    expect(result).toBe("webgpu");
  }, 60_000);
}
