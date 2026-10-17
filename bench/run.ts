// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Demux benchmark: snowy core vs libav.js vs mediabunny on bench/media (see
// scripts/gen-bench-media.ts), in real browsers with disk-backed Files from <input type=file>.
// Reports the median of --runs fresh workers and the shipped size (gzip/brotli) of each.
//
// Usage: bun bench/run.ts [--browsers chromium,firefox,webkit] [--libs snowy,libav,mediabunny]
//          [--core dist/core] [--avio 4194304] [--runs 3] [--out bench/results/name.json]

import { parseArgs } from "node:util";
import { brotliCompressSync, constants } from "node:zlib";
import { type BrowserType, chromium, firefox, webkit } from "playwright";
import { serve } from "../test/support/server";

const { values: args } = parseArgs({
  options: {
    browsers: { type: "string", default: "chromium,firefox,webkit" },
    libs: { type: "string", default: "snowy,libav,mediabunny" },
    core: { type: "string", default: "dist/core" },
    avio: { type: "string", default: String(1 << 22) },
    runs: { type: "string", default: "3" },
    out: { type: "string" },
  },
});

const root = new URL("../", import.meta.url).pathname;
const media = ["1080p.mp4", "1080p-faststart.mp4", "1080p.mkv", "1080p.ts"].map(
  (n) => `${root}bench/media/${n}`,
);

const SEEKS = [137.3, 12.1, 251.7, 64.4, 199.9, 3.2, 288.5, 171, 95.6, 230.2];
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };

// What each library ships to the browser for demuxing.
const shipped: Record<string, string[]> = {
  snowy: [`${args.core}/core.js`, `${args.core}/core.wasm`],
  libav: [
    "libav-6.10.9.0-webcodecs.mjs",
    "libav-6.10.9.0-webcodecs.wasm.mjs",
    "libav-6.10.9.0-webcodecs.wasm.wasm",
  ].map((f) => `node_modules/libav.js/dist/${f}`),
  mediabunny: ["node_modules/mediabunny/dist/bundles/mediabunny.min.mjs"],
};

interface Size {
  raw: number;
  gzip: number;
  brotli: number;
}

async function size(files: string[]): Promise<Size> {
  const total = { raw: 0, gzip: 0, brotli: 0 };

  for (const f of files) {
    const buf = await Bun.file(root + f).bytes();
    total.raw += buf.length;
    total.gzip += Bun.gzipSync(buf, { level: 9 }).length;
    total.brotli += brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  }

  return total;
}

type Json = number | string | boolean | null | undefined | { [key: string]: Json };

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[xs.length >> 1];

// Median of every numeric field across runs; strings and errors come from the first run.
function merge(runs: Json[]): Json {
  const [first] = runs;
  if (typeof first === "number") return median(runs.filter((r) => typeof r === "number"));
  if (first === null || typeof first !== "object") return first;
  return Object.fromEntries(
    Object.keys(first).map((k) => [
      k,
      merge(runs.map((r) => (r !== null && typeof r === "object" ? r[k] : undefined))),
    ]),
  );
}

const server = serve('<!doctype html><title>bench</title><input type="file" multiple>');

const libs = args.libs.split(",");
const result = {
  date: new Date().toISOString(),
  core: args.core,
  avio: Number(args.avio),
  runs: Number(args.runs),
  size: {} as Record<string, Size>,
  browsers: {} as Record<string, Record<string, Json>>,
};

for (const lib of libs) {
  const files = shipped[lib];
  if (!files) throw new Error(`unknown library ${lib}`);
  result.size[lib] = await size(files);
}

for (const name of args.browsers.split(",")) {
  const engine = engines[name];
  if (!engine) throw new Error(`unknown browser ${name}`);
  const browser = await engine.launch();
  const tab = await browser.newPage();
  tab.on("console", (m) => m.type() === "error" && console.error(`[${name}]`, m.text()));
  await tab.goto(server.url.href);
  await tab.locator("input").setInputFiles(media);
  const perBrowser: Record<string, Json> = { version: browser.version() };
  result.browsers[name] = perBrowser;

  for (const lib of libs) {
    const runs: Json[] = [];

    for (let i = 0; i < Number(args.runs); i++) {
      const run = await tab.evaluate(
        (msg) =>
          new Promise<Json>((resolve) => {
            const worker = new Worker("/bench/worker.js", { type: "module" });

            const done = (data: Json) => {
              worker.terminate();
              resolve(data);
            };

            worker.addEventListener("message", (e) => done(e.data));
            worker.addEventListener("error", (e) => done({ error: e.message }));
            const files = [...(document.querySelector("input")?.files ?? [])];
            worker.postMessage({ ...msg, files });
          }),
        { lib, opts: { core: `/${args.core}`, avioBuffer: Number(args.avio) }, seeks: SEEKS },
      );
      runs.push(run);
    }

    perBrowser[lib] = merge(runs);
    console.error(name, lib, JSON.stringify(perBrowser[lib]));
  }

  await browser.close();
}

await server.stop(true);

const json = `${JSON.stringify(result, null, 2)}\n`;
if (args.out) await Bun.write(root + args.out, json);
else process.stdout.write(json);
