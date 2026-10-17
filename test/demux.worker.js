// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Test worker: demuxes each fixture with the WASM core through FileReaderSync I/O, decodes
// every audio stream, and reports what native FFmpeg reports (see scripts/gen-fixtures.ts).
// With ?transfer, every audio stream goes through the copy that feeds audio-ext.

import {
  AV_NOPTS_VALUE,
  AVERROR_EOF,
  AVSEEK_FLAG_BACKWARD,
  AVSEEK_FLAG_BYTE,
  createCore,
} from "/dist/core/index.js";
import { createAudioDecoders } from "/test/support/audio-decoder.js";
import { attachFileSource } from "/test/support/file-source.js";

const TYPES = ["video", "audio", "data", "subtitle", "attachment"];
// Must match PROBE_STRIDE in scripts/gen-fixtures.ts.
const PROBE_STRIDE = 127;

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

async function createDemuxer() {
  const core = await createCore();
  core._sny_set_log_level(16); // errors only
  const source = attachFileSource(core);
  const transferAll = new URL(import.meta.url).searchParams.has("transfer");
  const openAudioDecoder = createAudioDecoders(core, transferAll);

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
        if (stream.type !== "audio") continue;
        stream.audio = { frames: 0, samples: 0, firstPts: [] };
        const decoder = await openAudioDecoder(ctx, i);
        const d = { audio: stream.audio, chunks: [], decoder };
        d.onFrame = (m, fltp) => append(d, m, fltp);
        decoders.set(i, d);
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
        d.audio.pcm = concat(d.chunks);
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

  return demux;
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;

  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }

  return out;
}

// Replaces the decoded samples with what the expectations hold: their SHA-256, and every
// PROBE_STRIDE-th value for comparing float decoders within a tolerance.
async function summarize(result) {
  for (const s of result.streams ?? []) {
    if (!s.audio) continue;
    const { pcm, ...audio } = s.audio;
    const digest = await crypto.subtle.digest("SHA-256", pcm);
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"));
    const probe = Array.from(pcm.filter((_, i) => i % PROBE_STRIDE === 0));
    s.audio = { ...audio, sha256: sha256.join(""), probe };
  }

  return result;
}

// Started before any await so the first message isn't lost.
const ready = createDemuxer();

async function run(names) {
  const demux = await ready;
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

  self.postMessage(results);
}

self.addEventListener("message", ({ data }) => void run(data));
