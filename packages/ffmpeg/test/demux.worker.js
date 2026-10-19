// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Test worker: demuxes each fixture with the WASM core through FileReaderSync I/O, decodes
// every audio and video stream, and reports what native FFmpeg reports (see
// scripts/gen-fixtures.ts). With ?transfer, streams core decodes also go through the copy
// that feeds the other modules.

import {
  AV_NOPTS_VALUE,
  AVERROR_EINVAL,
  AVERROR_EOF,
  AVSEEK_FLAG_BACKWARD,
  AVSEEK_FLAG_BYTE,
  createCore,
} from "/dist/core/index.js";
import { createDecoders } from "/test/support/decoder.js";
import { attachFileSource } from "/test/support/file-source.js";

const TYPES = ["video", "audio", "data", "subtitle", "attachment"];
// Must match PROBE_STRIDE in scripts/gen-fixtures.ts.
const PROBE_STRIDE = 127;
// The video modules' thread pool (VIDEO_LDFLAGS in the Dockerfile). Video decodes on up to 4
// threads, so frame threading runs in the tests.
const POOL = Math.min(navigator.hardwareConcurrency, 8);
const THREADS = Math.min(POOL, 4);

const timestamp = (v) => (v === AV_NOPTS_VALUE ? null : String(v));

// Appends a frame decoded in module m to d.audio, channels interleaved as native FFmpeg
// writes them.
function append(d, m, fltp) {
  const n = m._sny_frame_samples(fltp);
  const channels = m._sny_frame_channels(fltp);
  const pcm = new Float32Array(n * channels);

  for (let c = 0; c < channels; c++) {
    const plane = m._sny_frame_plane(fltp, c) >> 2;
    for (let i = 0; i < n; i++) pcm[i * channels + c] = m.HEAPF32[plane + i];
  }

  d.chunks.push(pcm);
  d.audio.frames++;
  d.audio.samples += n;
  if (d.audio.firstPts.length < 3) d.audio.firstPts.push(timestamp(m._sny_frame_pts(fltp)));
}

// The frame's planes packed as native FFmpeg's rawvideo encoder writes them, copied out of
// the WASM heap.
function pack(m, frame) {
  const size = m._sny_frame_pack_size(frame);
  if (size < 0) throw new Error(`frame_pack_size: ${size}`);
  const dst = m._malloc(size);
  const written = m._sny_frame_pack(frame, dst, size);
  const bytes = m.HEAPU8.slice(dst, dst + size);
  m._free(dst);
  if (written < 0) throw new Error(`frame_pack: ${written}`);
  return bytes;
}

// "ok" when `out`, a frame converted by sny_to_video_format and packed as `bytes`,
// constructs a VideoFrame.
function toVideoFrame(m, out, bytes) {
  const at = m._sny_frame_video_format(out);
  if (!at) return `no VideoFrame format for ${m.UTF8ToString(m._sny_frame_pix_fmt(out))}`;
  const format = m.UTF8ToString(at);
  const init = {
    format,
    codedWidth: m._sny_frame_width(out),
    codedHeight: m._sny_frame_height(out),
    timestamp: 0,
  };

  try {
    new VideoFrame(bytes, init).close();
    return "ok";
  } catch (e) {
    return `${format}: ${String(e)}`;
  }
}

// Appends a frame decoded in module m to d.video, packed as native FFmpeg writes it, and
// its converted form, when sny_to_video_format converted it, to d.converted; and checks that
// the converted form makes a VideoFrame.
function appendVideo(d, m, out, frame) {
  const v = d.video;
  v.frames++;
  if (v.firstPts.length < 3) v.firstPts.push(timestamp(m._sny_frame_pts(frame)));
  v.width ??= m._sny_frame_width(frame);
  v.height ??= m._sny_frame_height(frame);
  v.pixFmt ??= m.UTF8ToString(m._sny_frame_pix_fmt(frame));
  v.rotation ??= m._sny_frame_rotation(frame);
  const raw = pack(m, frame);
  d.chunks.push(raw);
  const pixFmt = m.UTF8ToString(m._sny_frame_pix_fmt(out));
  let bytes = raw;

  if (pixFmt !== v.pixFmt) {
    bytes = pack(m, out);
    v.convertedTo ??= pixFmt;
    d.converted.push(bytes);
  }

  if (v.videoFrame === "ok") v.videoFrame = toVideoFrame(m, out, bytes);
}

async function createDemuxer() {
  const core = await createCore();
  core._sny_set_log_level(16); // errors only
  const source = attachFileSource(core);
  const transferAll = new URL(import.meta.url).searchParams.has("transfer");
  const openDecoder = createDecoders(core, { transferAll });

  const str = (ptr) => (ptr ? core.UTF8ToString(ptr) : null);

  const pts = (pkt) => timestamp(core._sny_packet_pts(pkt));

  function check(ret, what) {
    if (ret < 0) throw new Error(`${what}: ${str(core._sny_strerror(ret))}`);
    return ret;
  }

  async function demux(file) {
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(1, 1 << 22, name, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(name);
    core._free(out);
    check(opened, "open");
    const pkt = core._sny_packet_alloc();
    const decoders = new Map();

    try {
      check(core._sny_find_stream_info(ctx), "find_stream_info");
      const streams = [];

      for (let i = 0; i < core._sny_nb_streams(ctx); i++) {
        const st = core._sny_stream(ctx, i);
        const stream = {
          type: TYPES[core._sny_codec_type(st)],
          codec: str(core._sny_codec_name(st)),
          packets: 0,
          firstPts: [],
        };
        streams.push(stream);

        if (stream.type === "audio") {
          stream.audio = { frames: 0, samples: 0, firstPts: [] };
          const decoder = await openDecoder(ctx, i);
          const d = { audio: stream.audio, chunks: [], decoder };
          d.onFrame = (m, fltp) => append(d, m, fltp);
          decoders.set(i, d);
        } else if (stream.type === "video") {
          stream.video = { frames: 0, firstPts: [], videoFrame: "ok" };
          const decoder = await openDecoder(ctx, i, THREADS);
          const d = { video: stream.video, chunks: [], converted: [], decoder };
          d.onFrame = (m, converted, frame) => appendVideo(d, m, converted, frame);
          decoders.set(i, d);
        }
      }

      for (;;) {
        const ret = core._sny_read(ctx, pkt);
        if (ret === AVERROR_EOF) break;
        check(ret, "read");
        const index = core._sny_packet_stream(pkt);
        const s = streams[index];
        s.packets++;
        if (s.firstPts.length < 3) s.firstPts.push(pts(pkt));
        const d = decoders.get(index);
        d?.decoder.decode(pkt, d.onFrame);
      }

      for (const d of decoders.values()) {
        d.decoder.decode(0, d.onFrame); // drain

        if (d.audio) {
          d.audio.pcm = concat(d.chunks, Float32Array);
        } else {
          d.video.raw = concat(d.chunks, Uint8Array);
          if (d.converted.length > 0) d.video.converted = concat(d.converted, Uint8Array);
        }
      }

      // Seek back to the start and confirm the next packet is that stream's first packet again.
      // Formats with no timestamps or index (raw elementary streams) seek by byte instead.
      let rewind = "unseekable";
      const seeked =
        core._sny_seek(ctx, -1, 0n, AVSEEK_FLAG_BACKWARD) >= 0 ||
        core._sny_seek(ctx, -1, 0n, AVSEEK_FLAG_BYTE) >= 0;

      if (seeked && core._sny_read(ctx, pkt) >= 0) {
        rewind =
          pts(pkt) === streams[core._sny_packet_stream(pkt)].firstPts[0]
            ? "ok"
            : `landed at ${pts(pkt)}`;
      }

      return { format: str(core._sny_format_name(ctx)), streams, rewind };
    } finally {
      for (const d of decoders.values()) d.decoder.close();
      core._sny_packet_free(pkt);
      core._sny_close(ctx);
    }
  }

  // Opens video stream 0 of `file` on one thread more than the pool has: "rejected" when it
  // fails cleanly, as it must, instead of hanging.
  async function openBeyondPool(file) {
    source.open(file);
    const out = core._malloc(4);
    const opened = core._sny_open(1, 1 << 22, 0, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(out);
    check(opened, "open");

    try {
      const decoder = await openDecoder(ctx, 0, POOL + 1);
      decoder.close();
      return "opened";
    } catch (e) {
      return String(e).includes("decoder_open_params") ? "rejected" : String(e);
    } finally {
      core._sny_close(ctx);
    }
  }

  // Opens stream 0 of subtitle file `file` in core and sends and receives on it: "rejected"
  // when both return AVERROR(EINVAL), as they must instead of corrupting memory.
  function decodeSubtitles(file) {
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);
    const opened = core._sny_open(1, 1 << 22, name, out);
    const ctx = core.HEAP32[out >> 2];
    core._free(name);
    if (opened < 0) core._free(out);
    check(opened, "open");
    const decoded = core._sny_decoder_open(ctx, 0, out);
    const dec = core.HEAP32[out >> 2];
    core._free(out);
    const pkt = core._sny_packet_alloc();
    const frame = core._sny_frame_alloc();

    try {
      check(decoded, "decoder_open");
      check(core._sny_read(ctx, pkt), "read");
      const sent = core._sny_decoder_send(dec, pkt);
      const received = core._sny_decoder_receive(dec, frame);
      return sent === AVERROR_EINVAL && received === AVERROR_EINVAL
        ? "rejected"
        : `send ${sent}, receive ${received}`;
    } finally {
      if (decoded >= 0) core._sny_decoder_close(dec);
      core._sny_frame_free(frame);
      core._sny_packet_free(pkt);
      core._sny_close(ctx);
    }
  }

  return { demux, openBeyondPool, decodeSubtitles, transferAll };
}

function concat(chunks, Type) {
  const out = new Type(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;

  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }

  return out;
}

async function sha256(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Replaces the decoded output with what the expectations hold: its SHA-256, and for audio
// every PROBE_STRIDE-th value for comparing float decoders within a tolerance.
async function summarize(result) {
  for (const s of result.streams ?? []) {
    if (s.audio) {
      const { pcm, ...audio } = s.audio;
      const probe = Array.from(pcm.filter((_, i) => i % PROBE_STRIDE === 0));
      const digest = await sha256(pcm);
      s.audio = { ...audio, sha256: digest, probe };
    } else if (s.video) {
      const { raw, converted, convertedTo, ...video } = s.video;
      const digest = await sha256(raw);
      s.video = { ...video, sha256: digest };

      if (converted) {
        const convertedDigest = await sha256(converted);
        s.video.converted = { pixFmt: convertedTo, sha256: convertedDigest };
      }
    }
  }

  return result;
}

// Started before any await so the first message isn't lost.
const ready = createDemuxer();

async function run(names) {
  const { demux, openBeyondPool, decodeSubtitles, transferAll } = await ready;
  const results = {};

  for (const name of names) {
    try {
      const res = await fetch(`/test/fixtures/${name}`);
      const blob = await res.blob();
      const file = new File([blob], name);
      const result = await demux(file);
      results[name] = await summarize(result);
    } catch (e) {
      results[name] = { error: String(e) };
    }
  }

  if (!transferAll) {
    const res = await fetch("/test/fixtures/h264.h264");
    const blob = await res.blob();
    results.threadPool = await openBeyondPool(new File([blob], "h264.h264"));
    const subs = await fetch("/test/fixtures/subs.srt");
    const text = await subs.blob();
    results.subtitleDecoder = decodeSubtitles(new File([text], "subs.srt"));
  }

  self.postMessage(results);
}

self.addEventListener("message", ({ data }) => void run(data));
