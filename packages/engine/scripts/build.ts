// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Bundles the engine and each of its workers into dist/ for browsers. Workers are entry points
// of their own, loaded by URL (src/index.ts), so each thread loads only its own code.

const src = new URL("../src/", import.meta.url).pathname;

await Bun.build({
  entrypoints: [`${src}index.ts`, `${src}render.worker.ts`],
  root: src,
  outdir: new URL("../dist/", import.meta.url).pathname,
  target: "browser",
  format: "esm",
});
