// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Engine benchmarks in Chromium, Firefox and WebKit on a GPU (test/support/browsers.ts). Each
// run is a fresh browser; every number is the median of --runs runs, in milliseconds. Prints a
// Markdown table and, with --out, writes the JSON.
//
// Usage: bun run bench [--browsers chromium,firefox,webkit] [--runs 5] [--out bench/results/name.json]

import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { browsers } from "../test/support/browsers";
import { ENTRY, MEDIA_WORKER, PAGE, RING_WORKER, serveEngine } from "../test/support/serve";

const { values: args } = parseArgs({
  options: {
    browsers: { type: "string", default: Object.keys(browsers).join(",") },
    runs: { type: "string", default: "5" },
    out: { type: "string" },
  },
});

type Timings = Record<string, number>;

// name -> what it measures, run in a fresh page with the engine at ENTRY.
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
    }, ENTRY),
  // engine.open until it resolves, for files already in memory. First is the first file in a
  // new engine, including whatever is left of loading the FFmpeg core; long is a ten-minute MP4
  // after it.
  open: (tab) =>
    tab.evaluate(async (entry) => {
      const engine: typeof import("../src/index") = await import(entry);
      const started = await engine.createEngine({ canvas: document.createElement("canvas") });

      const dir = "/test/fixtures/";

      async function load(name: string) {
        const res = await fetch(dir + name);
        const blob = await res.blob();
        return new File([blob], name);
      }

      async function time(file: File) {
        const start = performance.now();
        await started.open(file);
        return performance.now() - start;
      }

      const [short, long] = await Promise.all([load("h264-aac.mp4"), load("sync-10min.mp4")]);
      const first = await time(short);
      const tenMinutes = await time(long);
      started.close();
      return { first, long: tenMinutes };
    }, ENTRY),
  // The packet ring between two workers (ring.worker.ts), at the engine's capacity: moving
  // 256 MiB in packets of 1 KiB, 64 KiB and 1 MiB, and how late the consumer wakes up for a
  // packet written every 2 ms (median and 99th percentile).
  ring: (tab) =>
    tab.evaluate(
      async ({ page, worker }) => {
        const { createRing, RING_CAPACITY }: typeof import("../test/support/page") = await import(
          page
        );
        const total = 256 << 20;

        async function run(size: number, count: number, interval: number) {
          const ring = createRing(RING_CAPACITY);
          const [consumer, producer] = [0, 1].map(() => new Worker(worker, { type: "module" }));
          const done = new Promise<import("./ring.worker").RingResult>((resolve) => {
            consumer?.addEventListener("message", (e) => resolve(e.data), { once: true });
          });
          const { port1, port2 } = new MessageChannel();
          const jobs: import("./ring.worker").RingJob[] = [
            { role: "consume", ring, wake: port2 },
            { role: "produce", ring, wake: port1, size, count, interval },
          ];
          consumer?.postMessage(jobs[0], [port2]);
          producer?.postMessage(jobs[1], [port1]);
          const result = await done;
          consumer?.terminate();
          producer?.terminate();
          return result;
        }

        const timings: Record<string, number> = {};

        for (const [label, size] of [
          ["1 KiB", 1 << 10],
          ["64 KiB", 1 << 16],
          ["1 MiB", 1 << 20],
        ] as const) {
          const { ms } = await run(size, total / size, 0);
          timings[`256 MiB in ${label}`] = ms;
        }

        const { latencies } = await run(1 << 10, 500, 2);
        const at = (q: number) => latencies[Math.floor(q * (latencies.length - 1))] ?? NaN;
        timings["wake p50"] = at(0.5);
        timings["wake p99"] = at(0.99);
        return timings;
      },
      { page: PAGE, worker: RING_WORKER },
    ),
  // The media worker decoding the ten-minute AAC track into the PCM ring, in stereo at 48 kHz
  // (the track's rate: no resampling) and at 44.1 kHz, while the page drains the ring in
  // large reads; until the worker replies.
  audio: (tab) =>
    tab.evaluate(
      async ({ page, worker }) => {
        const support: typeof import("../test/support/page") = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch("/test/fixtures/sync-10min.mp4");
        const blob = await res.blob();
        const file = new File([blob], "sync-10min.mp4");
        const read = 1 << 20;
        const output = [new Float32Array(read), new Float32Array(read)];

        async function time(rate: number) {
          // Opened again each time: the previous run left the demuxer at the end.
          await media.request({ type: "open", file });
          const pcm = support.createPcmRing(1 << 22, 2, rate);
          const consumer = support.createPcmConsumer(pcm);
          const state = { decoding: true };

          async function drain() {
            while (state.decoding) {
              consumer.read(output, 0);
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }

          const draining = drain();
          const start = performance.now();
          const ring = support.createRing(64);
          const { port1 } = new MessageChannel();
          const audio = { stream: 1, pcm, preroll: 0 };
          await media.request({ type: "demux", ring, wake: port1, streams: [], audio }, [port1]);
          const ms = performance.now() - start;
          state.decoding = false;
          await draining;
          return ms;
        }

        const native = await time(48_000);
        const resampled = await time(44_100);
        media.stop();
        return { "10 min at 48 kHz": native, "10 min at 44.1 kHz": resampled };
      },
      { page: PAGE, worker: MEDIA_WORKER },
    ),
};

const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

function median(xs: number[]) {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const server = await serveEngine("<!doctype html><title>bench</title>");
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

// Three significant digits, so a wake-up of microseconds shows; whole milliseconds from 100.
const format = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toPrecision(3));

// One row per benchmark and measurement, one column per browser.
const names = Object.keys(results);
const rows = Object.entries(benchmarks).flatMap(([bench]) =>
  Object.keys(results[names[0] ?? ""]?.[bench] ?? {}).map(
    (k) =>
      `| ${bench} ${k} | ${names.map((n) => format(results[n]?.[bench]?.[k] ?? 0)).join(" | ")} |`,
  ),
);
console.log(`| ms (median of ${runs}) | ${names.join(" | ")} |`);
console.log(`| --- |${names.map(() => " ---: |").join("")}`);
console.log(rows.join("\n"));

const json = { date: new Date().toISOString(), runs, results };
if (args.out) await Bun.write(args.out, `${JSON.stringify(json, null, 2)}\n`);
