// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Video decode benchmark: demux + decode of 10 seconds of 1080p30 per codec (see
// scripts/gen-bench-media.ts), each frame copied out of the WASM heap, in Chromium with
// disk-backed Files, at each thread count. Reports the median of --runs fresh workers, in
// frames per second.
//
// Usage: bun bench/video.ts [--runs 3] [--threads 1,2,4,8]
//          [--dist dist] [--out bench/results/name.json]

import { Glob } from "bun";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { serve } from "../../../tooling/test-server";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    threads: { type: "string", default: "1,2,4,8" },
    dist: { type: "string", default: "dist" },
    out: { type: "string" },
  },
});

const root = new URL("../", import.meta.url).pathname;
const media = await Array.fromAsync(new Glob("bench/media/video-*.mkv").scan(root));
if (media.length === 0) throw new Error("no video media: run bun scripts/gen-bench-media.ts");

interface Run {
  [file: string]: { ms: number; fps: number; frames: number; width: number; height: number };
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[xs.length >> 1] ?? 0;
const server = serve(
  new URL("../", import.meta.url),
  '<!doctype html><title>bench</title><input type="file" multiple>',
);
const result = {
  date: new Date().toISOString(),
  runs: Number(args.runs),
  browsers: {} as Record<string, Record<string, unknown>>,
};

const browser = await chromium.launch();
const tab = await browser.newPage();
tab.on("console", (m) => m.type() === "error" && console.error(m.text()));
await tab.goto(server.url.href);
await tab.locator("input").setInputFiles(media.toSorted().map((f) => root + f));
const measured: Record<string, Record<string, unknown>> = {};

for (const threads of args.threads.split(",").map(Number)) {
  const runs: Run[] = [];

  for (let i = 0; i < Number(args.runs); i++) {
    const run = await tab.evaluate(
      (message) =>
        new Promise<Run>((resolve, reject) => {
          const worker = new Worker("/bench/video.worker.js", { type: "module" });
          worker.addEventListener("message", (e) => {
            worker.terminate();
            resolve(e.data);
          });
          worker.addEventListener("error", (e) => reject(new Error(e.message)));
          const files = [...(document.querySelector("input")?.files ?? [])];
          worker.postMessage({ ...message, files });
        }),
      { threads, dist: `/${args.dist}` },
    );
    runs.push(run);
  }

  for (const file of Object.keys(runs[0] ?? {})) {
    const all = runs.map((r) => r[file]);
    const first = all[0];
    measured[file] ??= {};
    const byThreads = measured[file];

    if (!first || "error" in first) {
      byThreads[threads] = first;
      continue;
    }

    const fps = median(all.map((r) => r?.fps ?? 0));
    byThreads[threads] = { ...first, ms: median(all.map((r) => r?.ms ?? 0)), fps };
    console.error(file, `${threads} threads`, `${fps.toFixed(1)} fps`);
  }
}

result.browsers.chromium = { version: browser.version(), ...measured };
await browser.close();

await server.stop(true);
const json = `${JSON.stringify(result, null, 2)}\n`;
if (args.out) await Bun.write(root + args.out, json);
else process.stdout.write(json);
