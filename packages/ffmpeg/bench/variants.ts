// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Builds each build-flag variant into bench/variants/<name> (gitignored) and runs its
// benchmark on it (bench/run.ts on core, or bench/video.ts on video), writing
// bench/results/variants/<name>.json.
// Usage: bun bench/variants.ts [--browsers chromium] [--runs 3] [name ...]

import { $ } from "bun";
import { parseArgs } from "node:util";

interface Variant {
  /** Compile flags (rebuilds FFmpeg); the Dockerfile's OPT. */
  opt?: string;
  /** Extra link flags; the Dockerfile's EXTRA_LDFLAGS. */
  ld?: string;
  /** Extra FFmpeg configure flags for the video module; the Dockerfile's EXTRA_CONFIGURE. */
  configure?: string;
  /** Benchmarks video decoding (bench/video.ts) instead of demuxing. */
  video?: boolean;
}

// "base" is the release configuration.
const VARIANTS: Record<string, Variant> = {
  base: {},
  growable: { ld: "-sGROWABLE_ARRAYBUFFERS=2" },
  mimalloc: { ld: "-sMALLOC=mimalloc" },
  emmalloc: { ld: "-sMALLOC=emmalloc" },
  closure: { ld: "--closure 1" },
  mem16: { ld: "-sINITIAL_MEMORY=16MB" },
  "no-lto": { opt: "-O3", ld: "-Wl,--Map=/out/core/core.map" },
  o2: { opt: "-O2 -flto" },
  os: { opt: "-Os -flto" },
  // FFmpeg's simd128 code is HEVC's; this measures what it buys.
  "no-simd128": { configure: "--disable-simd128", video: true },
  // With decoders on threads, the allocator's lock is contended.
  "video-mimalloc": { ld: "-sMALLOC=mimalloc", video: true },
};

const { values: args, positionals } = parseArgs({
  options: {
    browsers: { type: "string", default: "chromium" },
    runs: { type: "string", default: "3" },
  },
  allowPositionals: true,
});
$.cwd(new URL("../", import.meta.url).pathname);

for (const name of positionals.length > 0 ? positionals : Object.keys(VARIANTS)) {
  const variant = VARIANTS[name];
  if (!variant) throw new Error(`unknown variant ${name}`);
  const buildArgs = [
    ...(variant.opt ? ["--build-arg", `OPT=${variant.opt}`] : []),
    ...(variant.ld ? ["--build-arg", `EXTRA_LDFLAGS=${variant.ld}`] : []),
    ...(variant.configure ? ["--build-arg", `EXTRA_CONFIGURE=${variant.configure}`] : []),
  ];
  const out = `bench/variants/${name}`;
  console.error(`== ${name}`);
  await $`docker buildx build --target dist ${buildArgs} --output type=local,dest=${out} . 2>> .build.log`;
  const bench = variant.video
    ? ["bench/video.ts", "--dist", out]
    : ["bench/run.ts", "--libs", "snowy", "--core", `${out}/core`];
  await $`bun ${bench} --browsers ${args.browsers} --runs ${args.runs} --out bench/results/variants/${name}.json`;
}
