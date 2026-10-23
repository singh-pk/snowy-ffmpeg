// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Generates large benchmark files in bench/media (gitignored): one 5-minute 1080p30
// H.264 (20 Mb/s) + AAC encode, remuxed losslessly into each container we benchmark, one
// minute of audio in each codec the decode benchmark measures, and 10 seconds of 1080p30
// in each codec the video benchmark measures.
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

// Pink noise with a different seed per channel: harder for every decoder than music, and
// lossless codecs can't shrink identical channels.
function noise(channels: number) {
  const sources = Array.from(
    { length: channels },
    (_, i) => `anoisesrc=c=pink:r=48000:a=0.3:d=60:seed=${i + 1}[c${i}]`,
  );
  const pads = Array.from({ length: channels }, (_, i) => `[c${i}]`).join("");
  return ["-filter_complex", `${sources.join(";")};${pads}amerge=inputs=${channels}`];
}

// The codecs of film and streaming audio, at typical bit rates.
const audio: Record<string, string[]> = {
  "audio-eac3-51.mka": [...noise(6), "-c:a", "eac3", "-b:a", "640k"],
  "audio-truehd-51.mka": [...noise(6), "-c:a", "truehd", "-sample_fmt", "s32p", "-strict", "-2"],
  "audio-ac3-51.mka": [...noise(6), "-c:a", "ac3", "-b:a", "640k"],
  "audio-dts-51.mka": [...noise(6), "-c:a", "dca", "-strict", "-2"],
  "audio-aac.mka": [...noise(2), "-c:a", "aac", "-b:a", "256k"],
  "audio-opus.mka": [...noise(2), "-c:a", "libopus", "-b:a", "160k"],
  "audio-mp3.mka": [...noise(2), "-c:a", "libmp3lame", "-b:a", "320k"],
  "audio-flac-24.mka": [...noise(2), "-c:a", "flac", "-sample_fmt", "s32"],
};

for (const [name, args] of Object.entries(audio)) {
  const out = dir + name;
  const exists = await Bun.file(out).exists();
  if (!exists) await $`ffmpeg -hide_banner -loglevel error ${args} ${out}`;
}

// Moving test pattern with film grain at a streaming bit rate (8 Mb/s): the grain leaves
// residuals in every block, so decoders do real work, unlike on a clean synthetic source.
const SCENE = [
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1920x1080:rate=30:duration=10,noise=alls=12:allf=t",
  "-b:v",
  "8M",
  "-g",
  "60",
];

const video: Record<string, string[]> = {
  "video-h264.mkv": [...SCENE, "-c:v", "libx264", "-preset", "medium"],
  "video-hevc.mkv": [
    ...SCENE,
    "-c:v",
    "libx265",
    "-preset",
    "fast",
    "-x265-params",
    "log-level=none",
  ],
  "video-vp9.mkv": [
    ...SCENE,
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-row-mt",
    "1",
  ],
  "video-av1.mkv": [...SCENE, "-c:v", "libsvtav1", "-preset", "8"],
  // 10-bit 4:2:0 and 4:2:2, which VideoFrame takes as they are (I420P10, I422P10).
  "video-h264-10.mkv": [
    ...SCENE,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p10le",
  ],
  "video-prores-422.mkv": [
    ...SCENE,
    "-c:v",
    "prores_ks",
    "-profile:v",
    "2",
    "-pix_fmt",
    "yuv422p10le",
  ],
};

for (const [name, args] of Object.entries(video)) {
  const out = dir + name;
  const exists = await Bun.file(out).exists();
  if (!exists) await $`ffmpeg -hide_banner -loglevel error ${args} ${out}`;
}

for (const name of [...Object.keys(outputs), ...Object.keys(audio), ...Object.keys(video)]) {
  console.log(name, `${(Bun.file(dir + name).size / 2 ** 20).toFixed(1)} MiB`);
}
