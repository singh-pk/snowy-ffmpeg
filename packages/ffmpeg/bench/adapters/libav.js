// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Bench adapter for libav.js 6.10.9 (webcodecs variant: ogg/webm/mp4/flac/wav demuxers +
// H.264/HEVC/VP8/VP9/AV1/AAC parsers). Runs in-worker; a Blob is read through a readahead
// file (libav.js's recommended path; the variant has no WORKERFS), so the API is async.

import LibAV from "/node_modules/libav.js/dist/libav-6.10.9.0-webcodecs.mjs";

export async function create() {
  const libav = await LibAV.LibAV({ noworker: true });
  await libav.av_log_set_level(16);
  const state = { fmt: 0, pkt: 0, video: null };

  async function open(file) {
    await libav.mkreadaheadfile("in", file);
    const [fmt, streams] = await libav.ff_init_demuxer_file("in");
    state.fmt = fmt;
    state.video = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO);
    state.pkt = await libav.av_packet_alloc();
  }

  async function demux() {
    const { fmt, pkt } = state;
    let packets = 0;
    let bytes = 0;

    for (;;) {
      const [ret, out] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 1 << 20 });

      for (const list of Object.values(out)) {
        for (const p of list) {
          packets++;
          bytes += p.data.length;
        }
      }

      if (ret === libav.AVERROR_EOF) break;
      if (ret < 0 && ret !== -libav.EAGAIN) throw new Error(`read: ${ret}`);
    }

    return { packets, bytes };
  }

  async function seek(t) {
    const { fmt, pkt, video } = state;
    const [lo, hi] = libav.f64toi64(Math.round((t * video.time_base_den) / video.time_base_num));
    const ret = await libav.av_seek_frame(fmt, video.index, lo, hi, 1 /* AVSEEK_FLAG_BACKWARD */);
    if (ret < 0) throw new Error(`seek: ${ret}`);

    for (;;) {
      const [, out] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 1 });
      const p = out[video.index]?.[0];
      if (p) return (libav.i64tof64(p.pts, p.ptshi) * video.time_base_num) / video.time_base_den;
    }
  }

  async function close() {
    await libav.av_packet_free_js(state.pkt);
    await libav.avformat_close_input_js(state.fmt);
    await libav.unlinkreadaheadfile("in");
  }

  return { open, demux, seek, close, io: () => null, heapBytes: () => null };
}
