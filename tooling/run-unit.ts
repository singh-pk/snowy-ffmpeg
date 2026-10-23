// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Runs a package's unit tests in Chromium: bundles each `test/**/*.unit.ts` file, with the
// workers they start (`support`), into test/dist/unit, serves the package cross-origin
// isolated, and runs each file in a worker (tooling/unit-worker.ts) of a page of its own, as one bun:test test that lists the
// tests that failed. Bun only builds, serves and drives the browser; no test code runs in
// it. The browser is the Chromium build of the pinned Playwright version.

import { afterAll, expect, test } from "bun:test";
import { Glob } from "bun";
import { chromium } from "playwright";
import { serve } from "./test-server";
import { rm } from "node:fs/promises";
import type { Ran } from "./unit-worker";

interface Options {
  /** Worker entry points the tests start, relative to the package, such as test/support/x.ts. */
  support?: string[];
}

/** Registers a test for each unit test file of the package at `pkg`. */
export async function runUnitTests(pkg: URL, { support = [] }: Options = {}) {
  const files = [...new Glob("test/**/*.unit.ts").scanSync(pkg.pathname)].toSorted();
  const outdir = `${pkg.pathname}test/dist/unit/`;
  // Emptied first, so a test never loads a stale bundle of a file since renamed.
  await rm(outdir, { recursive: true, force: true });
  const runner = await Bun.build({
    entrypoints: [new URL("unit-worker.ts", import.meta.url).pathname],
    outdir: `${outdir}runner/`,
    target: "browser",
    format: "esm",
  });
  if (!runner.success) throw new AggregateError(runner.logs, "unit tests: runner build failed");
  const built = await Bun.build({
    entrypoints: [...files, ...support].map((f) => `${pkg.pathname}${f}`),
    root: `${pkg.pathname}test/`,
    outdir,
    target: "browser",
    format: "esm",
  });
  if (!built.success) throw new AggregateError(built.logs, "unit tests: build failed");
  const server = serve(pkg, "<!doctype html><title>unit tests</title>");
  const browser = await chromium.launch();

  afterAll(async () => {
    await browser.close();
    await server.stop(true);
  });

  for (const file of files) {
    test(
      file,
      async () => {
        const tab = await browser.newPage();
        const bundle = `/test/dist/unit/${file.slice("test/".length, -".ts".length)}.js`;
        const url = `/test/dist/unit/runner/unit-worker.js?file=${encodeURIComponent(bundle)}`;
        await tab.goto(server.url.href);

        // A runner that fails to load reports that instead.
        const { ran, failed } = await tab.evaluate(async (module) => {
          const worker = new Worker(module, { type: "module" });
          const done = Promise.withResolvers<Ran>();
          worker.addEventListener("message", ({ data }: MessageEvent<Ran>) => done.resolve(data));
          worker.addEventListener("error", (e) =>
            done.resolve({ ran: 0, failed: [`${e.message} (${e.filename}:${e.lineno})`] }),
          );
          const result = await done.promise;
          worker.terminate();
          return result;
        }, url);

        await tab.close();
        expect(failed).toEqual([]);
        // A file that registered nothing is a broken file, not a pass.
        expect(ran).toBeGreaterThan(0);
      },
      60_000,
    );
  }
}
