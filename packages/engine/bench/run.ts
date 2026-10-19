// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Engine benchmarks in Chromium, Firefox and WebKit on a GPU (test/support/browsers.ts). Each
// run is a fresh browser; every number is the median of --runs runs, in milliseconds. Prints a
// Markdown table and, with --out, writes the JSON. Build first (bun run build).
//
// Usage: bun run bench [--browsers chromium,firefox,webkit] [--runs 5] [--out bench/results/name.json]

import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { serve } from "../../../tooling/test-server";
import { browsers } from "../test/support/browsers";

const { values: args } = parseArgs({
  options: {
    browsers: { type: "string", default: Object.keys(browsers).join(",") },
    runs: { type: "string", default: "5" },
    out: { type: "string" },
  },
});

type Timings = Record<string, number>;

// name -> what it measures, run in a fresh page with the engine at /dist/index.js.
const benchmarks: Record<string, (tab: Page) => Promise<Timings>> = {
  // createEngine until it resolves: the platform check, the render worker and a GPU device.
  // Cold is the first engine in the page, warm a second one once the worker script is cached.
  startup: (tab) =>
    tab.evaluate(async (entry) => {
      const engine: typeof import("../src/index") = await import(entry);

      async function time() {
        const start = performance.now();
        const started = await engine.createEngine({ canvas: document.createElement("canvas") });
        const ms = performance.now() - start;
        started.close();
        return ms;
      }

      const cold = await time();
      const warm = await time();
      return { cold, warm };
    }, "/dist/index.js"),
};

const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

function median(xs: number[]) {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const server = serve(new URL("../", import.meta.url), "<!doctype html><title>bench</title>");
const results: Record<string, Record<string, Timings>> = {};

for (const name of args.browsers.split(",")) {
  const entry = browsers[name];
  if (!entry) throw new Error(`unknown browser ${name}`);
  const [type, options] = entry;
  const measured: Record<string, Timings[]> = {};

  for (let i = 0; i < runs; i++) {
    const browser = await type.launch(options);
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    for (const [bench, measure] of Object.entries(benchmarks)) {
      const timings = await measure(tab);
      (measured[bench] ??= []).push(timings);
    }

    await browser.close();
  }

  results[name] = Object.fromEntries(
    Object.entries(measured).map(([bench, all]) => {
      const keys = Object.keys(all[0] ?? {});
      return [bench, Object.fromEntries(keys.map((k) => [k, median(all.map((t) => t[k] ?? 0))]))];
    }),
  );
}

await server.stop(true);

// One row per benchmark and measurement, one column per browser.
const names = Object.keys(results);
const rows = Object.entries(benchmarks).flatMap(([bench]) =>
  Object.keys(results[names[0] ?? ""]?.[bench] ?? {}).map(
    (k) =>
      `| ${bench} ${k} | ${names.map((n) => (results[n]?.[bench]?.[k] ?? 0).toFixed(1)).join(" | ")} |`,
  ),
);
console.log(`| ms (median of ${runs}) | ${names.join(" | ")} |`);
console.log(`| --- |${names.map(() => " ---: |").join("")}`);
console.log(rows.join("\n"));

const json = { date: new Date().toISOString(), runs, results };
if (args.out) await Bun.write(args.out, `${JSON.stringify(json, null, 2)}\n`);
