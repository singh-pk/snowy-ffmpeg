// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Bench adapter for the snowy core: FileReaderSync I/O through AVIO, packets copied out
// of the heap as a WebCodecs hand-off would.

import { AVERROR_EOF, AVMEDIA_TYPE_VIDEO, AVSEEK_FLAG_BACKWARD } from "/dist/core/index.js";
import { attachFileSource } from "/test/support/file-source.js";

// `core` is the URL of a directory holding core.js + core.wasm (a build variant).
export async function create({ core: base = "/dist/core", avioBuffer = 1 << 22 }) {
  const { default: createCore } = await import(`${base}/core.js`);
  const core = await createCore();
  core._sny_set_log_level(16);
  const source = attachFileSource(core);
  const state = { ctx: 0, pkt: 0, video: 0, timeBase: [1, 1] };

  function check(ret, what) {
    if (ret < 0) throw new Error(`${what}: ${core.UTF8ToString(core._sny_strerror(ret))}`);
    return ret;
  }

  async function open(file) {
    source.open(file);
    const out = core._malloc(4);
    const name = core.stringToNewUTF8(file.name);

    try {
      check(core._sny_open(1, avioBuffer, name, out), "open");
      state.ctx = core.HEAP32[out >> 2];
    } finally {
      core._free(name);
      core._free(out);
    }

    const { ctx } = state;
    check(core._sny_find_stream_info(ctx), "find_stream_info");
    state.pkt = core._sny_packet_alloc();
    let video = 0;
    while (core._sny_codec_type(core._sny_stream(ctx, video)) !== AVMEDIA_TYPE_VIDEO) video++;
    const st = core._sny_stream(ctx, video);
    state.video = video;
    state.timeBase = [core._sny_stream_tb_num(st), core._sny_stream_tb_den(st)];
  }

  async function demux() {
    const { ctx, pkt } = state;
    let packets = 0;
    let bytes = 0;

    for (;;) {
      const ret = core._sny_read(ctx, pkt);
      if (ret === AVERROR_EOF) break;
      check(ret, "read");
      const data = core._sny_packet_data(pkt);
      bytes += core.HEAPU8.slice(data, data + core._sny_packet_size(pkt)).length;
      packets++;
    }

    return { packets, bytes };
  }

  // Seeks to the video keyframe at or before `t` seconds; returns its pts in seconds.
  async function seek(t) {
    const { ctx, pkt, video } = state;
    const [num, den] = state.timeBase;
    check(
      core._sny_seek(ctx, video, BigInt(Math.round((t * den) / num)), AVSEEK_FLAG_BACKWARD),
      "seek",
    );
    do check(core._sny_read(ctx, pkt), "read");
    while (core._sny_packet_stream(pkt) !== video);
    return (Number(core._sny_packet_pts(pkt)) * num) / den;
  }

  async function close() {
    core._sny_packet_free(state.pkt);
    core._sny_close(state.ctx);
  }

  return {
    open,
    demux,
    seek,
    close,
    io: () => source.stats,
    heapBytes: () => core.HEAPU8.length,
  };
}
