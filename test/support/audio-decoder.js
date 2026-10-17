// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Decodes one audio stream to 32-bit float planar frames. Shared by the tests and the
// benchmarks, and the loop every caller needs: send each packet, take every frame it
// produces, and drain with a null packet at the end.

import { AVERROR_EAGAIN, AVERROR_EOF } from "/dist/core/index.js";

/**
 * Opens a decoder for `stream` of the demuxer `ctx`. `decode(pkt, onFrame)` calls
 * `onFrame(frame)` with every float planar frame the packet completes (pkt 0 drains);
 * read it with the `_sny_frame_*` getters before returning. A packet the decoder rejects on
 * send is skipped, as the ffmpeg command line does; an error receiving a frame throws.
 */
export function openAudioDecoder(core, ctx, stream) {
  const check = (ret, what) => {
    if (ret < 0) throw new Error(`${what}: ${core.UTF8ToString(core._sny_strerror(ret))}`);
    return ret;
  };

  const out = core._malloc(4);
  const opened = core._sny_decoder_open(ctx, stream, out);
  const dec = core.HEAP32[out >> 2];
  core._free(out);
  check(opened, "decoder_open");
  const swr = core._sny_converter_alloc();
  const frame = core._sny_frame_alloc();
  const fltp = core._sny_frame_alloc();

  function receive(onFrame) {
    for (;;) {
      const ret = core._sny_decoder_receive(dec, frame);
      if (ret === AVERROR_EAGAIN || ret === AVERROR_EOF) return;
      check(ret, "decoder_receive");
      check(core._sny_to_float_planar(swr, frame, fltp), "to_float_planar");
      onFrame(fltp);
    }
  }

  function decode(pkt, onFrame) {
    for (;;) {
      const ret = core._sny_decoder_send(dec, pkt);
      receive(onFrame);
      if (ret !== AVERROR_EAGAIN) return;
    }
  }

  function close() {
    core._sny_frame_free(fltp);
    core._sny_frame_free(frame);
    core._sny_converter_free(swr);
    core._sny_decoder_close(dec);
  }

  return { decode, close };
}
