// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Generates the small container fixtures in test/fixtures and their expectations from
// native ffprobe. Requires ffmpeg/ffprobe 9.0.2 on PATH (same version as the WASM build).
// Usage: bun scripts/gen-fixtures.ts

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";

const dir = new URL("../test/fixtures/", import.meta.url).pathname;
// No random IDs (Matroska segment UID, Ogg serial) or version tags, so output is reproducible.
const OUT = ["-fflags", "+bitexact"];
const V = ["-f", "lavfi", "-i", "testsrc2=size=128x96:rate=10:duration=1"];
const A = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1"];
const AV = [...V, ...A];
// A different tone per channel, so a swapped or dropped channel shows in the decoded output.
const tones = (n: number) =>
  Array.from({ length: n }, (_, i) => `0.5*sin(${330 + 110 * i}*2*PI*t)`).join("|");
const STEREO = ["-f", "lavfi", "-i", `aevalsrc=${tones(2)}:s=48000:d=0.5:c=stereo`];
const SURROUND = ["-f", "lavfi", "-i", `aevalsrc=${tones(6)}:s=48000:d=0.5:c=5.1`];

// name -> ffmpeg output arguments (inputs are prepended). Each covers one demuxer or one
// audio decoder.
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
  "eac3-51.mka": [...SURROUND, "-c:a", "eac3"],
  "truehd-51.thd": [...SURROUND, "-c:a", "truehd", "-strict", "-2"],
  "dts-51.dts": [...SURROUND, "-c:a", "dca", "-strict", "-2"],
  "flac-24.flac": [...STEREO, "-c:a", "flac", "-sample_fmt", "s32"],
  "pcm-24.wav": [...STEREO, "-c:a", "pcm_s24le"],
  "adpcm.wav": [...STEREO, "-c:a", "adpcm_ima_wav"],
  "audio.wv": [...STEREO, "-c:a", "wavpack"],
  "audio.tta": [...STEREO, "-c:a", "tta"],
  // Decoded by audio-ext.
  "ra144.rm": [...A, "-c:a", "real_144", "-ar", "8000", "-ac", "1"],
  "nellymoser.flv": [...A, "-c:a", "nellymoser", "-ar", "22050", "-ac", "1"],
  "g723_1.tco": [...A, "-c:a", "g723_1", "-ar", "8000", "-ac", "1", "-b:a", "6300", "-f", "g723_1"],
  "audio.sbc": [...STEREO, "-c:a", "sbc"],
};

await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

for (const [name, args] of Object.entries(fixtures)) {
  await $`ffmpeg -hide_banner -loglevel error -y ${args} ${OUT} ${dir + name}`;
}

// MKV without cues: the matroska muxer only writes cues to seekable output.
await $`ffmpeg -hide_banner -loglevel error ${AV} -c:v libx264 -c:a aac ${OUT} -f matroska pipe:1 > ${dir}nocues.mkv`;

// Subtitles: one SRT source, converted to the other text formats and muxed into MKV.
await Bun.write(
  `${dir}subs.srt`,
  "1\n00:00:00,000 --> 00:00:00,500\nHello\n\n2\n00:00:00,500 --> 00:00:01,000\nWorld\n",
);
for (const out of ["subs.ass", "subs.vtt"])
  await $`ffmpeg -hide_banner -loglevel error -i ${dir}subs.srt ${OUT} ${dir + out}`;
await $`ffmpeg -hide_banner -loglevel error ${AV} -i ${dir}subs.srt -map 0 -map 1 -map 2 -c:v libx264 -c:a aac -c:s ass ${OUT} ${dir}h264-aac-ass.mkv`;

// Every 127th decoded value: enough to catch a shifted, dropped or swapped frame or channel.
const PROBE_STRIDE = 127;

interface Stream {
  codec_type: string;
  codec_name: string;
  sample_fmt?: string;
}

interface Packet {
  stream_index: number;
  pts?: number;
}

interface Frame {
  nb_samples: number;
  pts?: number;
}

// Decoded audio of stream `index` as native FFmpeg produces it: 32-bit float, channels
// interleaved, with assembly off so float decoders run the same C code as the WASM build.
async function decodeAudio(file: string, index: number, format: string) {
  const { frames }: { frames: Frame[] } =
    await $`ffprobe -v error -select_streams ${index} -show_frames -show_entries frame=nb_samples,pts -of json ${file}`.json();
  const pcm =
    await $`ffmpeg -v error -cpuflags 0 -i ${file} -map 0:${index} -c:a pcm_f32le -f f32le -`.arrayBuffer();
  const samples = new Float32Array(pcm);
  const probe = samples.filter((_, i) => i % PROBE_STRIDE === 0);
  // Integer decoders are exact on every CPU; float ones differ in the last bits (FMA, SIMD).
  const exact = !/^(flt|dbl)/.test(format);

  return {
    frames: frames.length,
    samples: frames.reduce((n, f) => n + f.nb_samples, 0),
    firstPts: frames.slice(0, 3).map((f) => (f.pts === undefined ? null : String(f.pts))),
    sha256: new Bun.CryptoHasher("sha256").update(pcm).digest("hex"),
    exact,
    ...(exact ? {} : { probe: Buffer.from(probe.buffer).toString("base64") }),
  };
}

// Expectations from native FFmpeg: container name, streams, packet count and first pts per
// stream, and for audio streams the decoded output.
const expected: Record<string, unknown> = {};
const listing = await $`ls ${dir}`.text();
const names = listing
  .trim()
  .split("\n")
  .filter((n) => n !== "expected.json");

for (const name of names) {
  const file = dir + name;
  const probe =
    await $`ffprobe -v error -show_format -show_streams -show_packets -of json ${file}`.json();
  const packets: Packet[] = probe.packets ?? [];
  const probed: Stream[] = probe.streams;
  const streams = [];

  for (const [i, s] of probed.entries()) {
    const pkts = packets.filter((p) => p.stream_index === i);
    const stream = {
      type: s.codec_type,
      codec: s.codec_name,
      packets: pkts.length,
      firstPts: pkts.slice(0, 3).map((p) => (p.pts === undefined ? null : String(p.pts))),
    };

    if (s.codec_type !== "audio") {
      streams.push(stream);
      continue;
    }

    const audio = await decodeAudio(file, i, s.sample_fmt ?? "");
    streams.push({ ...stream, audio });
  }

  expected[name] = { format: probe.format.format_name, streams };
}

await Bun.write(`${dir}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(`${names.length} fixtures`);
