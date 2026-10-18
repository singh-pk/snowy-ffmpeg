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

// name -> ffmpeg output arguments (inputs are prepended). Each covers one demuxer, one
// decoder or one pixel format.
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
  "mjpeg.avi": [...V, "-c:v", "mjpeg"],
  "mjpeg-422.avi": [...V, "-c:v", "mjpeg", "-pix_fmt", "yuvj422p"],
  // A display matrix: coded side data, carried to the video module with the codec parameters.
  "rotated.mp4": ["-display_rotation", "90", "-noautorotate", ...V, "-c:v", "libx264"],
  "vp8.webm": [...V, "-c:v", "libvpx"],
  "h264-10.mkv": [...V, "-c:v", "libx264", "-pix_fmt", "yuv420p10le"],
  "h264-10-full.mkv": [...V, "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-color_range", "pc"],
  "gray.nut": [...V, "-c:v", "ffv1", "-pix_fmt", "gray"],
  // Odd size: Firefox takes it only in RGB, so a VideoFrame format is converted too.
  "odd.y4m": [...V, "-vf", "scale=127:95", "-pix_fmt", "yuv420p"],
  // One per VideoFrame format not covered above.
  "alpha.nut": [...V, "-c:v", "ffv1", "-pix_fmt", "yuva420p"],
  "prores-4444.mov": [...V, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"],
  "nv12.nut": [...V, "-c:v", "rawvideo", "-pix_fmt", "nv12"],
  "rgba.nut": [...V, "-c:v", "rawvideo", "-pix_fmt", "rgba"],
  "bgr0.nut": [...V, "-c:v", "rawvideo", "-pix_fmt", "bgr0"],
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

interface VideoFrame {
  pts?: number;
  width: number;
  height: number;
  pix_fmt: string;
  side_data_list?: { side_data_type: string; rotation?: number }[];
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

// The pixel format sny_to_video_format converts each fixture's video to, where VideoFrame
// doesn't accept the decoder's (src/video.c); native libswscale decides the pixels.
const CONVERTED: Record<string, string> = {
  "prores-pcm.mov": "yuv420p", // 10-bit 4:2:2
  "h264-10.mkv": "yuv420p", // 10-bit 4:2:0
  "h264-10-full.mkv": "yuv420p", // full range stays full range
  "anim.apng": "rgb0", // rgb24
  "gray.nut": "rgb0",
  "mjpeg-422.avi": "yuv420p", // full-range 4:2:2
  "odd.y4m": "rgb0", // 4:2:0 of odd size
  "prores-4444.mov": "yuva420p", // 10-bit 4:4:4 with alpha
};

const sha256 = (data: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

// Decoded video of stream `index` as native FFmpeg produces it: every frame, in the
// decoder's own pixel format, planes packed as the rawvideo encoder writes them, and in the
// format of CONVERTED when the fixture has one. Video decoders and libswscale are exact, so
// the hashes must match.
async function decodeVideo(file: string, name: string, index: number, codec: string) {
  // FFmpeg's own av1 decoder needs hardware; the WASM build decodes AV1 with dav1d.
  const dec = codec === "av1" ? ["-c:v", "libdav1d"] : [];
  const { frames }: { frames: VideoFrame[] } =
    await $`ffprobe -v error ${dec} -select_streams ${index} -show_entries frame=pts,width,height,pix_fmt:frame_side_data=side_data_type,rotation -of json ${file}`.json();
  // As the decoder outputs it: not rotated, not converted, no frame dropped or repeated.
  const decode = (vf: string[]) =>
    $`ffmpeg -v error -cpuflags 0 -noautorotate ${dec} -i ${file} -map 0:${index} -fps_mode passthrough ${vf} -c:v rawvideo -f rawvideo -`.arrayBuffer();
  const raw = await decode([]);
  const first = frames[0];
  const target = CONVERTED[name];
  const conversion = target ? decode(["-vf", `format=${target}`]) : null;
  const converted = await conversion;

  return {
    frames: frames.length,
    firstPts: frames.slice(0, 3).map((f) => (f.pts === undefined ? null : String(f.pts))),
    width: first?.width,
    height: first?.height,
    pixFmt: first?.pix_fmt,
    // Coded side data, such as a container's display matrix, reaches the frames.
    rotation:
      first?.side_data_list?.find((s) => s.side_data_type === "3x3 displaymatrix")?.rotation ?? 0,
    sha256: sha256(raw),
    ...(converted ? { converted: { pixFmt: target, sha256: sha256(converted) } } : {}),
  };
}

// Expectations from native FFmpeg: container name, streams, packet count and first pts per
// stream, and for audio and video streams the decoded output.
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

    if (s.codec_type === "audio") {
      const audio = await decodeAudio(file, i, s.sample_fmt ?? "");
      streams.push({ ...stream, audio });
    } else if (s.codec_type === "video") {
      const video = await decodeVideo(file, name, i, s.codec_name);
      streams.push({ ...stream, video });
    } else {
      streams.push(stream);
    }
  }

  expected[name] = { format: probe.format.format_name, streams };
}

await Bun.write(`${dir}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(`${names.length} fixtures`);
