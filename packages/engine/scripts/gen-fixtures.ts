// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Generates the test videos in test/fixtures and their expectations, test/fixtures/expected.json,
// from native ffprobe. Every video frame carries its number (test/support/frame-id.ts) and the
// audio clicks at every whole second, so a test can measure which frame is shown when, and
// where audio and video drift apart. Before writing anything it decodes every fixture
// natively and checks every frame number and click. Requires ffmpeg and ffprobe 9.0.2 on
// PATH, the version @snowy-media/ffmpeg builds. Usage: bun run fixtures

import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PCM_CHANNELS, PCM_RATE, probe as probeSamples } from "../test/support/audio";
import { brightnessGrid, CELL, FRAME_ID_BITS, readFrameId } from "../test/support/frame-id";

const dir = new URL("../test/fixtures/", import.meta.url).pathname;
const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const RATE = 48_000;
// The click's length, and how far from a whole second a decoded click may start.
const CLICK = 0.002;
const CLICK_TOLERANCE = 0.001;

// SVT-AV1 logs its configuration to stderr unless told not to.
$.env({ ...process.env, SVT_LOG: "1" });

for (const tool of ["ffmpeg", "ffprobe"]) {
  const version = await $`${tool} -version`.text();
  if (!version.startsWith(`${tool} version 9.0.2 `)) throw new Error(`needs ${tool} 9.0.2 on PATH`);
}

// The frame number over the top band, in limited range (16 black, 235 white). geq works in
// each plane's own coordinates, and the chroma planes have half as many rows.
const bit = `mod(floor(N/pow(2,floor(X/${CELL}))),2)`;
const code = [
  `lum='if(lt(Y,${CELL}),if(lt(X,${CELL * FRAME_ID_BITS}),16+219*${bit},16),lum(X,Y))'`,
  `cb='if(lt(Y,${CELL / 2}),128,cb(X,Y))'`,
  `cr='if(lt(Y,${CELL / 2}),128,cr(X,Y))'`,
].join(":");

// Moving test pattern, or flat grey for the long fixture, which only needs the numbers.
const video = (seconds: number, source = "testsrc2=", fps = FPS) => [
  "-f",
  "lavfi",
  "-i",
  `${source}size=${WIDTH}x${HEIGHT}:rate=${fps}:duration=${seconds},format=yuv420p,geq=${code}`,
];

// A 4 kHz burst at every whole second, the same in both channels.
const clicks = (seconds: number) => [
  "-f",
  "lavfi",
  "-i",
  `aevalsrc='if(lt(mod(t,1),${CLICK}),0.8*sin(2*PI*4000*t),0)':s=${RATE}:d=${seconds}:c=stereo`,
];

// One keyframe a second and none in between, so a seek usually decodes forward from one.
const GOP = ["-g", String(FPS), "-keyint_min", String(FPS), "-sc_threshold", "0"];
const H264 = ["-c:v", "libx264", ...GOP];
const HEVC = [
  "-c:v",
  "libx265",
  "-tag:v",
  "hvc1",
  "-x265-params",
  `keyint=${FPS}:min-keyint=${FPS}:scenecut=0:log-level=none`,
];
const VP9 = ["-c:v", "libvpx-vp9", "-g", String(FPS)];
// Alt-ref frames, which libvpx makes only in two passes, and WebM stores as packets that make
// no frame.
const VP8_ALTREF = ["-c:v", "libvpx", "-b:v", "1M", "-g", String(FPS), "-auto-alt-ref", "1"];
const AV1 = ["-c:v", "libsvtav1", "-g", String(FPS)];
const AAC = ["-c:a", "aac"];
const OPUS = ["-c:a", "libopus"];
// No random IDs or version tags, so the output is reproducible.
const OUT = ["-fflags", "+bitexact"];

// name -> its length, the ffmpeg arguments after the inputs, and those for the video input;
// and its frame rate and its audio's length, where they are not FPS and its length. Every
// fixture has a frame for each frame period of it and a click for each second of its audio.
const fixtures: Record<
  string,
  {
    seconds: number;
    args: string[];
    source?: string;
    input?: string[];
    fps?: number;
    audioSeconds?: number;
    twoPass?: boolean;
  }
> = {
  "h264-aac.mp4": { seconds: 3, args: [...H264, ...AAC] },
  "h264-aac.mkv": { seconds: 3, args: [...H264, ...AAC] },
  "hevc-aac.mp4": { seconds: 3, args: [...HEVC, ...AAC] },
  "vp9-opus.webm": { seconds: 3, args: [...VP9, ...OPUS] },
  "av1-opus.webm": { seconds: 3, args: [...AV1, ...OPUS] },
  // Variable frame rate: frames last one frame and a frame and a half, alternately.
  "vfr-h264-aac.mkv": {
    seconds: 3,
    args: [
      "-vf",
      `settb=1/${2 * FPS},setpts='2*N+floor(N/2)'`,
      "-fps_mode",
      "passthrough",
      "-enc_time_base:v",
      `1/${2 * FPS}`,
      ...H264,
      ...AAC,
    ],
  },
  // A display matrix: shown a quarter turn anticlockwise, and also mirrored.
  "rotated-h264-aac.mp4": {
    seconds: 1,
    args: [...H264, ...AAC],
    input: ["-display_rotation", "90", "-noautorotate"],
  },
  "flipped-h264-aac.mp4": {
    seconds: 1,
    args: [...H264, ...AAC],
    input: ["-display_rotation", "90", "-display_hflip", "-noautorotate"],
  },
  // A frame every two seconds, a longer gap than the PCM ring holds, and so one keyframe
  // (docs/architecture.md#playback).
  "sparse-h264-aac.mp4": { seconds: 12, fps: 0.5, args: [...H264, ...AAC] },
  // Audio for a tenth of a second, less than play buffers before it starts, under 3 s of video.
  "short-audio-h264-aac.mp4": { seconds: 3, audioSeconds: 0.1, args: [...H264, ...AAC] },
  "altref-vp8-opus.webm": { seconds: 3, args: [...VP8_ALTREF, ...OPUS], twoPass: true },
  // Ten minutes, for drift.
  "sync-10min.mp4": { seconds: 600, args: [...H264, ...AAC], source: "color=c=gray:" },
};

interface Packet {
  codec_type: string;
  stream_index: number;
  pts?: number;
  dts?: number;
  size: string;
  flags: string;
  data_hash: string;
}

interface Stream {
  index: number;
  codec_type: string;
  codec_name: string;
  time_base: string;
  start_time?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}

// The presentation timestamps of video stream `index`, and the frame number on each frame.
async function readVideo(file: string, index: number, width: number, height: number) {
  const { frames }: { frames: { pts: number }[] } =
    await $`ffprobe -v error -select_streams ${index} -show_entries frame=pts -of json ${file}`.json();
  const grey =
    await $`ffmpeg -v error -noautorotate -i ${file} -map 0:${index} -fps_mode passthrough -pix_fmt gray -f rawvideo -`.arrayBuffer();
  const size = width * height;
  if (grey.byteLength !== frames.length * size) throw new Error(`${file}: frame count differs`);
  const ids = frames.map((_, i) => readFrameId(new Uint8Array(grey, i * size, size), width));
  return { pts: frames.map((f) => f.pts), ids };
}

// The size the first frame of video stream `index` is shown at, turned by its display matrix,
// and the brightness grid (test/support/frame-id.ts) of it as FFmpeg shows it, in RGB.
async function referenceGrid(file: string, index: number, width: number, height: number) {
  const { streams }: { streams: { side_data_list?: { rotation?: number }[] }[] } =
    await $`ffprobe -v error -select_streams ${index} -show_entries stream_side_data=rotation -of json ${file}`.json();
  const rotation = streams[0]?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  const turned = Math.abs(rotation ?? 0) % 180 === 90;
  const [w, h] = turned ? [height, width] : [width, height];
  const rgb =
    await $`ffmpeg -v error -i ${file} -map 0:${index} -frames:v 1 -pix_fmt rgb24 -f rawvideo -`.arrayBuffer();
  if (rgb.byteLength !== w * h * 3) throw new Error(`${file}: the shown frame is not ${w}x${h}`);
  return { shown: [w, h], grid: brightnessGrid(new Uint8Array(rgb), w, h, 3, 1) };
}

// A stream's packets as the engine's tests hash them: one line `pts,dts,key,size,crc32` per
// packet, an unknown timestamp empty, crc32 in lowercase hex. dts is left out (`pts,key,...`)
// unless the container stores it, as MP4 does: where it does not (Matroska), libavformat
// guesses it from the decoder's delay, and the engine's demuxer has no video decoders, so the
// guess depends on the build, not the file.
function hashPackets(packets: Packet[], index: number, dts: boolean) {
  const lines = packets
    .filter((p) => p.stream_index === index)
    .map((p) => {
      const crc = p.data_hash.replace("CRC32:", "");
      const times = dts ? `${p.pts ?? ""},${p.dts ?? ""}` : String(p.pts ?? "");
      return `${times},${p.flags.startsWith("K") ? 1 : 0},${p.size},${crc}`;
    });
  const sha256 = new Bun.CryptoHasher("sha256").update(lines.join("\n")).digest("hex");
  return { packets: lines.length, packetsSha256: sha256 };
}

// The time each click starts, in seconds on the stream's timeline.
async function readClicks(file: string, stream: Stream) {
  const left = "pan=mono|c0=c0";
  const pcm =
    await $`ffmpeg -v error -i ${file} -map 0:${stream.index} -af ${left} -f f32le -`.arrayBuffer();
  const samples = new Float32Array(pcm);
  const start = Number(stream.start_time ?? 0);
  const onsets: number[] = [];
  let quietUntil = 0;

  for (const [i, s] of samples.entries()) {
    if (i < quietUntil || Math.abs(s) < 0.3) continue;
    onsets.push(start + i / RATE);
    quietUntil = i + RATE / 2;
  }

  return onsets;
}

// The codec string FFmpeg's HLS muxer writes for video stream `index`, for the codecs it
// builds one from the stream's own data: H.264 and AV1. (Its VP9 level is a placeholder, and
// it writes none for HEVC.)
async function hlsCodec(file: string, index: number, codec: string) {
  if (codec !== "h264" && codec !== "av1") return undefined;
  const out = await mkdtemp(join(tmpdir(), "snowy-hls-"));

  try {
    await $`ffmpeg -v error -i ${file} -map 0:${index} -c copy -f hls -hls_segment_type fmp4 -master_pl_name master.m3u8 ${join(out, "media.m3u8")}`;
    const master = await Bun.file(join(out, "master.m3u8")).text();
    const codecs = /CODECS="([^"]+)"/.exec(master)?.[1];
    if (!codecs) throw new Error(`${file}: no CODECS in the HLS playlist`);
    return codecs;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

// Audio stream `index` as `ffmpeg -ar -ac` resamples it for the tests (test/support/audio.ts):
// its length in frames, and its probe.
async function resample(file: string, index: number) {
  const pcm =
    await $`ffmpeg -v error -cpuflags 0 -i ${file} -map 0:${index} -ar ${PCM_RATE} -ac ${PCM_CHANNELS} -f f32le -`.arrayBuffer();
  const samples = new Float32Array(pcm);
  return {
    frames: samples.length / PCM_CHANNELS,
    probe: probeSamples(samples.length, (i) => samples[i] ?? 0),
  };
}

// Encodes `file` from `inputs` with `args`; in two passes if `twoPass`, the first logging to
// a directory of its own.
async function encode(file: string, inputs: string[], args: string[], twoPass = false) {
  if (!twoPass) {
    await $`ffmpeg -hide_banner -loglevel error -y ${inputs} ${args} ${OUT} ${file}`;
    return;
  }

  const log = await mkdtemp(join(tmpdir(), "snowy-pass-"));
  const passlog = ["-passlogfile", join(log, "pass")];

  try {
    await $`ffmpeg -hide_banner -loglevel error -y ${inputs} ${args} -pass 1 ${passlog} -an -f null -`;
    await $`ffmpeg -hide_banner -loglevel error -y ${inputs} ${args} -pass 2 ${passlog} ${OUT} ${file}`;
  } finally {
    await rm(log, { recursive: true, force: true });
  }
}

await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const expected: Record<string, unknown> = {};

for (const [name, fixture] of Object.entries(fixtures)) {
  const { seconds, args, source, input = [], fps = FPS, audioSeconds = seconds, twoPass } = fixture;
  const file = dir + name;
  const inputs = [...input, ...video(seconds, source, fps), ...clicks(audioSeconds)];
  await encode(file, inputs, args, twoPass);

  const probe =
    await $`ffprobe -v error -show_format -show_streams -show_entries packet=codec_type,stream_index,pts,dts,size,flags,data_hash -show_data_hash crc32 -of json ${file}`.json();
  const streams: Stream[] = probe.streams;
  const packets: Packet[] = probe.packets;
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v?.width || !v.height || !a) throw new Error(`${name}: needs a video and an audio stream`);
  const { pts, ids } = await readVideo(file, v.index, v.width, v.height);
  if (ids.length !== seconds * fps) throw new Error(`${name}: ${ids.length} frames`);
  const wrong = ids.findIndex((id, i) => id !== i);
  if (wrong >= 0) throw new Error(`${name}: frame ${wrong} reads as ${ids[wrong]}`);
  const onsets = await readClicks(file, a);
  if (onsets.length !== Math.ceil(audioSeconds))
    throw new Error(`${name}: ${onsets.length} clicks`);
  const late = onsets.findIndex((t, k) => Math.abs(t - k) > CLICK_TOLERANCE);
  if (late >= 0) throw new Error(`${name}: click ${late} starts at ${onsets[late]} s`);
  const resampled = await resample(file, a.index);
  const codecString = await hlsCodec(file, v.index, v.codec_name);
  const keyframes = packets.filter((p) => p.codec_type === "video" && p.flags.startsWith("K"));
  const reference = await referenceGrid(file, v.index, v.width, v.height);

  const dts = name.endsWith(".mp4");

  expected[name] = {
    format: probe.format.format_name,
    // Whether the packet hashes include dts (hashPackets).
    packetDts: dts,
    duration: Number(probe.format.duration),
    video: {
      id: v.index,
      codec: v.codec_name,
      ...(codecString ? { codecString } : {}),
      timeBase: v.time_base,
      width: v.width,
      height: v.height,
      // Frame i shows the number i, so this is also every frame's number in order.
      pts,
      keyframes: keyframes.map((p) => p.pts),
      // The first frame as shown (referenceGrid).
      ...reference,
      ...hashPackets(packets, v.index, dts),
    },
    audio: {
      id: a.index,
      codec: a.codec_name,
      sampleRate: Number(a.sample_rate),
      channels: a.channels,
      clicks: onsets.length,
      ...hashPackets(packets, a.index, dts),
      // As the tests play it (test/support/audio.ts).
      resampled,
    },
  };
  console.log(name, `${pts.length} frames`, `${onsets.length} clicks`);
}

// One fixture a line: readable, and a regenerated fixture changes one line.
const lines = Object.entries(expected).map(
  ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
);
await Bun.write(`${dir}expected.json`, `{\n${lines.join(",\n")}\n}\n`);
