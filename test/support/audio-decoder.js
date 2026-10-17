// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Decodes audio streams to 32-bit float planar frames. Shared by the tests and the
// benchmarks, and the loop every caller needs: send each packet, take every frame it
// produces, and drain with a null packet at the end. A codec core doesn't decode is decoded
// by audio-ext, loaded on first use, with the same loop.

import { AVERROR_DECODER_NOT_FOUND, AVERROR_EAGAIN, AVERROR_EOF } from "/dist/core/index.js";

async function loadAudioExt() {
  const { createAudioExt } = await import("/dist/audio-ext/index.js");
  const ext = await createAudioExt();
  ext._sny_set_log_level(16); // errors only
  return ext;
}

function check(m, ret, what) {
  if (ret < 0) throw new Error(`${what}: ${m.UTF8ToString(m._sny_strerror(ret))}`);
  return ret;
}

// Calls open(out) and returns the decoder it stores, or the negative AVERROR it returns.
function openWith(m, open) {
  const out = m._malloc(4);
  const ret = open(out);
  const dec = m.HEAP32[out >> 2];
  m._free(out);
  return ret < 0 ? ret : dec;
}

/**
 * Returns `open(ctx, stream)`, which opens a decoder for `stream` of the demuxer `ctx` in
 * `core`. `decode(pkt, onFrame)` calls `onFrame(m, frame)` with every float planar frame the
 * packet completes (pkt 0 drains), where `m` is the module holding the frame; read it with
 * `m._sny_frame_*` before returning. A packet the decoder rejects on send is skipped, as the
 * ffmpeg command line does; an error receiving a frame throws. With `transferAll`, streams
 * core decodes also go through the copy that feeds audio-ext, into core itself (for tests).
 */
export function createAudioDecoders(core, transferAll = false) {
  let ext = null; // audio-ext, once a stream needs it

  async function open(ctx, stream) {
    const dec = openWith(core, (out) => core._sny_decoder_open(ctx, stream, out));

    if (dec !== AVERROR_DECODER_NOT_FOUND) {
      check(core, dec, "decoder_open");
      if (!transferAll) return loop(core, dec);
      core._sny_decoder_close(dec);
      return transfer(core, core, ctx, stream);
    }

    ext ??= loadAudioExt();
    const m = await ext;
    return transfer(core, m, ctx, stream);
  }

  return open;
}

// Opens a decoder for `stream` in module `m`, copying the stream's codec parameters and then
// each packet from core.
function transfer(core, m, ctx, stream) {
  const out = core._malloc(4);
  const size = core._sny_params_export(ctx, stream, out);
  const params = core.HEAP32[out >> 2];
  core._free(out);
  check(core, size, "params_export");
  const buf = m._malloc(size);

  if (!buf) {
    core._free(params);
    throw new Error("malloc: out of memory");
  }

  m.HEAPU8.set(core.HEAPU8.subarray(params, params + size), buf);
  core._free(params);
  const dec = openWith(m, (o) => m._sny_decoder_open_params(buf, size, o));
  m._free(buf);
  check(m, dec, "decoder_open_params");
  const pkt = m._sny_packet_alloc();

  if (!pkt) {
    m._sny_decoder_close(dec);
    throw new Error("packet_alloc: out of memory");
  }

  function copy(src) {
    if (!src) return 0;
    const n = core._sny_packet_size(src);
    const data = m._sny_packet_make(
      pkt,
      n,
      core._sny_packet_pts(src),
      core._sny_packet_dts(src),
      core._sny_packet_duration(src),
      core._sny_packet_flags(src),
    );
    if (!data) throw new Error("packet_make: out of memory");
    const start = core._sny_packet_data(src);
    m.HEAPU8.set(core.HEAPU8.subarray(start, start + n), data);

    for (let i = 0; i < core._sny_packet_side_data_count(src); i++) {
      const bytes = core._sny_packet_side_data_size(src, i);
      const type = core._sny_packet_side_data_type(src, i);
      const to = m._sny_packet_side_data_add(pkt, type, bytes);
      if (!to) throw new Error("packet_side_data_add: out of memory");
      const from = core._sny_packet_side_data(src, i);
      m.HEAPU8.set(core.HEAPU8.subarray(from, from + bytes), to);
    }

    return pkt;
  }

  return loop(m, dec, copy, () => m._sny_packet_free(pkt));
}

// The send/receive loop over decoder `dec` of module `m`. `toPacket` turns core's packet into
// one of `m`'s.
function loop(m, dec, toPacket = (pkt) => pkt, release = () => {}) {
  const swr = m._sny_converter_alloc();
  const frame = m._sny_frame_alloc();
  const fltp = m._sny_frame_alloc();

  function receive(onFrame) {
    for (;;) {
      const ret = m._sny_decoder_receive(dec, frame);
      if (ret === AVERROR_EAGAIN || ret === AVERROR_EOF) return;
      check(m, ret, "decoder_receive");
      check(m, m._sny_to_float_planar(swr, frame, fltp), "to_float_planar");
      onFrame(m, fltp);
    }
  }

  function decode(pkt, onFrame) {
    const p = toPacket(pkt);

    for (;;) {
      const ret = m._sny_decoder_send(dec, p);
      receive(onFrame);
      if (ret !== AVERROR_EAGAIN) return;
    }
  }

  function close() {
    m._sny_frame_free(fltp);
    m._sny_frame_free(frame);
    m._sny_converter_free(swr);
    m._sny_decoder_close(dec);
    release();
  }

  return { decode, close };
}
