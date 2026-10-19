// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Bundles the engine and each of its workers for browsers. Workers are entry points of their
// own, loaded by URL (src/index.ts), so each thread loads only its own code.
//
// @snowy-media/ffmpeg stays an import, so the app's bundler resolves it together with the
// WebAssembly files it loads by URL. A page served without a bundler (the tests) passes
// `ffmpeg`, the URL path the ffmpeg package is served under, and the imports point there.

import { dirname } from "node:path";

const src = new URL("../src/", import.meta.url).pathname;

interface Options {
  /** Where the bundles go. */
  outdir: string;
  /** The URL path the ffmpeg package is served under, instead of leaving it to a bundler. */
  ffmpeg?: string;
}

// Points each @snowy-media/ffmpeg import at its file under the URL path `prefix`.
function ffmpegAt(prefix: string): Bun.BunPlugin {
  const root = `${dirname(Bun.resolveSync("@snowy-media/ffmpeg/package.json", src))}/`;

  return {
    name: "ffmpeg-url",
    setup(b) {
      b.onResolve({ filter: /^@snowy-media\/ffmpeg\// }, (args) => ({
        path: prefix + Bun.resolveSync(args.path, args.importer).slice(root.length),
        external: true,
      }));
    },
  };
}

export async function build({ outdir, ffmpeg }: Options) {
  await Bun.build({
    entrypoints: ["index.ts", "media.worker.ts", "render.worker.ts"].map((f) => src + f),
    root: src,
    outdir,
    target: "browser",
    format: "esm",
    packages: "external",
    plugins: ffmpeg ? [ffmpegAt(ffmpeg)] : [],
  });
}

if (import.meta.main) await build({ outdir: new URL("../dist/", import.meta.url).pathname });
