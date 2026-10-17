// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Generates large benchmark files in bench/media (gitignored): one 5-minute 1080p30
// H.264 (20 Mb/s) + AAC encode, remuxed losslessly into each container we benchmark.
// Usage: bun scripts/gen-bench-media.ts

import { $ } from "bun";
import { mkdir } from "node:fs/promises";

const dir = new URL("../bench/media/", import.meta.url).pathname;
await mkdir(dir, { recursive: true });

const src = `${dir}source.mkv`;

const haveSource = await Bun.file(src).exists();

if (!haveSource) {
  await $`ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=300 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=300 -c:v libx264 -preset ultrafast -b:v 20M -maxrate 20M -bufsize 40M -g 60 -bf 2 -c:a aac -b:a 192k ${src}`;
}

// MP4 with the index at the end (as cameras write it), and one with faststart.
const outputs: Record<string, string[]> = {
  "1080p.mkv": [],
  "1080p.mp4": [],
  "1080p-faststart.mp4": ["-movflags", "+faststart"],
  "1080p.ts": [],
};

for (const [name, args] of Object.entries(outputs)) {
  const out = dir + name;
  const exists = await Bun.file(out).exists();
  if (!exists) await $`ffmpeg -hide_banner -loglevel error -i ${src} -map 0 -c copy ${args} ${out}`;
}

for (const name of Object.keys(outputs)) {
  console.log(name, `${(Bun.file(dir + name).size / 2 ** 20).toFixed(0)} MiB`);
}
