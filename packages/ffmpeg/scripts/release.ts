// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Prepares the GitHub release for tag vX.Y.Z (.github/workflows/release.yml): checks that the
// tag matches package.json and has a CHANGELOG.md section, and writes into release/
//   notes.md                          that section
//   snowy-ffmpeg-X.Y.Z-source.tar.xz  the repository at HEAD plus, in third_party/, the
//                                     FFmpeg, dav1d, zlib and bzip2 sources the modules are
//                                     built from: the source the LGPL requires (NOTICE)
// Usage: bun scripts/release.ts vX.Y.Z (needs Docker with buildx)

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";

const tag = process.argv[2] ?? "";
const root = new URL("../", import.meta.url).pathname;
const { version } = await Bun.file(`${root}package.json`).json();
if (tag !== `v${version}`) throw new Error(`tag "${tag}" is not v${version} from package.json`);

const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`));
if (!section) throw new Error(`CHANGELOG.md has no [${version}] section`);

const out = `${root}release/`;
const name = `snowy-ffmpeg-${version}`;
const stage = `${out}${name}/`;
await rm(out, { recursive: true, force: true });
await mkdir(`${stage}third_party`, { recursive: true });
await Bun.write(`${out}notes.md`, `${section.slice(section.indexOf("\n") + 1).trim()}\n`);

await $`git -C ${root} archive HEAD | tar -x -C ${stage}`;
await $`docker buildx build --target source --output type=local,dest=${stage}third_party ${root}`;
await $`tar -cJf ${out}${name}-source.tar.xz -C ${out} ${name}`;
await rm(stage, { recursive: true });
console.log(`release/${name}-source.tar.xz`);
