// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Test worker: demuxes each fixture with the WASM core through FileReaderSync I/O and
// reports what native ffprobe reports (see scripts/gen-fixtures.ts).

import {
  AV_NOPTS_VALUE,
  AVERROR_EOF,
  AVSEEK_FLAG_BACKWARD,
  AVSEEK_FLAG_BYTE,
  createCore,
} from "/dist/core/index.js";
import { attachFileSource } from "/test/support/file-source.js";

const TYPES = ["video", "audio", "data", "subtitle", "attachment"];

async function createDemuxer() {
  const core = await createCore();
  core._sny_set_log_level(16); // errors only
  const source = attachFileSource(core);

  const str = (ptr) => (ptr ? core.UTF8ToString(ptr) : null);

  const pts = (pkt) => {
    const v = core._sny_packet_pts(pkt);
    return v === AV_NOPTS_VALUE ? null : String(v);
  };

  function check(ret, what) {
    if (ret < 0) throw new Error(`${what}: ${str(core._sny_strerror(ret))}`);
    return ret;
  }

  function demux(file) {
    source.open(file);
    const out = core._malloc(4);
    check(core._sny_open(1, 1 << 22, out), "open");
    const ctx = core.HEAP32[out >> 2];
    core._free(out);
    const pkt = core._sny_packet_alloc();

    try {
      check(core._sny_find_stream_info(ctx), "find_stream_info");
      const streams = [];

      for (let i = 0; i < core._sny_nb_streams(ctx); i++) {
        const st = core._sny_stream(ctx, i);
        streams.push({
          type: TYPES[core._sny_codec_type(st)],
          codec: str(core._sny_codec_name(st)),
          packets: 0,
          firstPts: [],
        });
      }

      for (;;) {
        const ret = core._sny_read(ctx, pkt);
        if (ret === AVERROR_EOF) break;
        check(ret, "read");
        const s = streams[core._sny_packet_stream(pkt)];
        s.packets++;
        if (s.firstPts.length < 3) s.firstPts.push(pts(pkt));
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
      core._sny_packet_free(pkt);
      core._sny_close(ctx);
    }
  }

  return demux;
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
      results[name] = demux(file);
    } catch (e) {
      results[name] = { error: String(e) };
    }
  }

  self.postMessage(results);
}

self.addEventListener("message", ({ data }) => void run(data));
