// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Audio decode benchmark: demux + decode to float planar of one minute of audio per codec
// (see scripts/gen-bench-media.ts), in Chromium with disk-backed Files. Reports the
// median of --runs fresh workers, as a multiple of real time.
//
// Usage: bun bench/decode.ts [--runs 3]
//          [--out bench/results/name.json]

import { Glob } from "bun";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { serve } from "../../../tooling/test-server";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    out: { type: "string" },
  },
});

const root = new URL("../", import.meta.url).pathname;
const media = await Array.fromAsync(new Glob("bench/media/audio-*.mka").scan(root));
if (media.length === 0) throw new Error("no audio media: run bun scripts/gen-bench-media.ts");

interface Run {
  [file: string]: { ms: number; realtime: number; samples: number; channels: number };
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
const runs: Run[] = [];

for (let i = 0; i < Number(args.runs); i++) {
  const run = await tab.evaluate(
    () =>
      new Promise<Run>((resolve, reject) => {
        const worker = new Worker("/bench/decode.worker.js", { type: "module" });
        worker.addEventListener("message", (e) => {
          worker.terminate();
          resolve(e.data);
        });
        worker.addEventListener("error", (e) => reject(new Error(e.message)));
        const files = [...(document.querySelector("input")?.files ?? [])];
        worker.postMessage({ files });
      }),
  );
  runs.push(run);
}

const measured: Record<string, unknown> = { version: browser.version() };

for (const file of Object.keys(runs[0] ?? {})) {
  const all = runs.map((r) => r[file]);
  const first = all[0];

  if (!first || "error" in first) {
    measured[file] = first;
    continue;
  }

  const ms = median(all.map((r) => r?.ms ?? 0));
  measured[file] = { ...first, ms, realtime: median(all.map((r) => r?.realtime ?? 0)) };
  console.error(
    file,
    `${ms.toFixed(0)} ms`,
    `${median(all.map((r) => r?.realtime ?? 0)).toFixed(0)}x`,
  );
}

result.browsers.chromium = measured;
await browser.close();

await server.stop(true);
const json = `${JSON.stringify(result, null, 2)}\n`;
if (args.out) await Bun.write(root + args.out, json);
else process.stdout.write(json);
