// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Builds the engine for a page without a bundler into test/dist, its ffmpeg imports pointing
// at /ffmpeg/, and serves the package with the ffmpeg package under /ffmpeg/. A page imports
// the engine from ENTRY. Shared by the tests and the benchmarks.

import { dirname } from "node:path";
import { serve } from "../../../../tooling/test-server";
import { build } from "../../scripts/build";

const pkg = new URL("../../", import.meta.url);
const ffmpeg = Bun.pathToFileURL(
  `${dirname(Bun.resolveSync("@snowy-media/ffmpeg/package.json", pkg.pathname))}/`,
);

export const ENTRY = "/test/dist/index.js";
// Once, however many servers a test starts.
const built = build({ outdir: `${pkg.pathname}test/dist/`, ffmpeg: "/ffmpeg/" });

export async function serveEngine(page: string, { isolated = true } = {}) {
  await built;
  return serve(pkg, page, { isolated, mounts: { "/ffmpeg/": ffmpeg } });
}
