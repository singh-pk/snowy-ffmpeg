// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Generates the small container fixtures in test/fixtures and their expectations from
// native ffprobe. Requires ffmpeg/ffprobe 9.0.2 on PATH (same version as the WASM build).
// Usage: bun scripts/gen-fixtures.ts

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";

const dir = new URL("../test/fixtures/", import.meta.url).pathname;
const V = ["-f", "lavfi", "-i", "testsrc2=size=128x96:rate=10:duration=1"];
const A = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1"];
const AV = [...V, ...A];

// name -> ffmpeg output arguments (inputs are prepended). Each covers one demuxer.
const fixtures: Record<string, string[]> = {
  "h264-aac.mkv": [...AV, "-c:v", "libx264", "-c:a", "aac"],
  "vp9-opus.webm": [...AV, "-c:v", "libvpx-vp9", "-c:a", "libopus"],
  "hevc-aac.mp4": [
    ...AV,
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-c:a",
    "aac",
    "-x265-params",
    "log-level=none",
  ],
  "prores-pcm.mov": [...AV, "-c:v", "prores", "-c:a", "pcm_s16le"],
  "mpeg4-mp3.avi": [...AV, "-c:v", "mpeg4", "-c:a", "libmp3lame"],
  "h264-ac3.ts": [...AV, "-c:v", "libx264", "-c:a", "ac3"],
  "mpeg2-mp2.mpg": [...AV, "-c:v", "mpeg2video", "-c:a", "mp2"],
  "h264-aac.flv": [...AV, "-c:v", "libx264", "-c:a", "aac"],
  "wmv2-wmav2.wmv": [...AV, "-c:v", "wmv2", "-c:a", "wmav2"],
  "ffv1-flac.nut": [...AV, "-c:v", "ffv1", "-c:a", "flac"],
  "h263-aac.3gp": [...AV, "-c:v", "h263", "-c:a", "aac", "-ar", "16000"],
  "av1.ivf": [...V, "-c:v", "libsvtav1"],
  "av1.obu": [...V, "-c:v", "libsvtav1", "-f", "obu"],
  "h264.h264": [...V, "-c:v", "libx264"],
  "hevc.hevc": [...V, "-c:v", "libx265", "-x265-params", "log-level=none"],
  "mpeg2.m2v": [...V, "-c:v", "mpeg2video"],
  "anim.gif": [...V, "-c:v", "gif"],
  "anim.apng": [...V, "-c:v", "apng", "-f", "apng"],
  "raw.y4m": [...V, "-pix_fmt", "yuv420p"],
  "opus.ogg": [...A, "-c:a", "libopus"],
  "vorbis.oga": [...A, "-c:a", "vorbis", "-strict", "-2", "-ac", "2"],
  "pcm.wav": [...A, "-c:a", "pcm_s16le"],
  "pcm.w64": [...A, "-c:a", "pcm_s16le"],
  "pcm.aiff": [...A, "-c:a", "pcm_s16be"],
  "alac.caf": [...A, "-c:a", "alac"],
  "alac.m4a": [...A, "-c:a", "alac"],
  "audio.flac": [...A, "-c:a", "flac"],
  "audio.mp3": [...A, "-c:a", "libmp3lame"],
  "adts.aac": [...A, "-c:a", "aac"],
  "audio.ac3": [...A, "-c:a", "ac3"],
  "audio.eac3": [...A, "-c:a", "eac3"],
  "audio.mp2": [...A, "-c:a", "mp2"],
};

await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

for (const [name, args] of Object.entries(fixtures)) {
  await $`ffmpeg -hide_banner -loglevel error -y ${args} ${dir + name}`;
}

// MKV without cues: the matroska muxer only writes cues to seekable output.
await $`ffmpeg -hide_banner -loglevel error ${AV} -c:v libx264 -c:a aac -f matroska pipe:1 > ${dir}nocues.mkv`;

// Subtitles: one SRT source, converted to the other text formats and muxed into MKV.
await Bun.write(
  `${dir}subs.srt`,
  "1\n00:00:00,000 --> 00:00:00,500\nHello\n\n2\n00:00:00,500 --> 00:00:01,000\nWorld\n",
);
for (const out of ["subs.ass", "subs.vtt"])
  await $`ffmpeg -hide_banner -loglevel error -i ${dir}subs.srt ${dir + out}`;
await $`ffmpeg -hide_banner -loglevel error ${AV} -i ${dir}subs.srt -map 0 -map 1 -map 2 -c:v libx264 -c:a aac -c:s ass ${dir}h264-aac-ass.mkv`;

// Expectations from native ffprobe: container name, streams, packet count and first pts per stream.
const expected: Record<string, unknown> = {};
const listing = await $`ls ${dir}`.text();
const names = listing
  .trim()
  .split("\n")
  .filter((n) => n !== "expected.json");

for (const name of names) {
  const probe =
    await $`ffprobe -v error -show_format -show_streams -show_packets -of json ${dir + name}`.json();
  expected[name] = {
    format: probe.format.format_name,
    streams: probe.streams.map((s: { codec_type: string; codec_name: string }, i: number) => {
      const pkts = (probe.packets ?? []).filter(
        (p: { stream_index: number }) => p.stream_index === i,
      );
      return {
        type: s.codec_type,
        codec: s.codec_name,
        packets: pkts.length,
        firstPts: pkts
          .slice(0, 3)
          .map((p: { pts?: number }) => (p.pts === undefined ? null : String(p.pts))),
      };
    }),
  };
}

await Bun.write(`${dir}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(`${names.length} fixtures`);
