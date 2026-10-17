// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Opens every fixture with the WASM core in Chromium, Firefox and WebKit and compares the
// result with native ffprobe 9.0.2. Usage: bun test (after building dist/).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import expected from "./fixtures/expected.json";

const root = new URL("../", import.meta.url).pathname;
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/")
      return new Response("<!doctype html><title>test</title>", {
        headers: { ...headers, "Content-Type": "text/html" },
      });
    const file = Bun.file(root + path.slice(1));
    const exists = await file.exists();
    return exists ? new Response(file, { headers }) : new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const fixtures: Record<string, Record<string, unknown>> = expected;
const names = Object.keys(fixtures);

for (const [engine, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
] as [string, BrowserType][]) {
  describe(engine, () => {
    let browser: Browser;
    let isolated = false;
    let results: Record<string, unknown> = {};

    beforeAll(async () => {
      browser = await type.launch();
      const page = await browser.newPage();
      page.on("console", (m) => m.type() === "error" && console.error(`[${engine}]`, m.text()));
      page.on("pageerror", (e) => console.error(`[${engine}]`, e.message));
      await page.goto(server.url.href);
      isolated = await page.evaluate(() => crossOriginIsolated);
      results = await page.evaluate(
        (list) =>
          new Promise((resolve) => {
            const worker = new Worker("/test/demux.worker.js", { type: "module" });
            worker.addEventListener("message", (e) => resolve(e.data));
            worker.addEventListener("error", (e) => resolve({ worker: e.message }));
            worker.postMessage(list);
          }),
        names,
      );
    }, 120_000);
    afterAll(() => browser?.close());

    test("page is cross-origin isolated", () => expect(isolated).toBe(true));

    for (const name of names) {
      test(name, () => expect(results[name]).toEqual({ ...fixtures[name], rewind: "ok" }));
    }
  });
}
