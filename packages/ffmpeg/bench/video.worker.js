// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Video decode benchmark worker, one fresh worker per run. Message: { files, threads, dist }.
// For each file: open, then demux and decode its first video stream on `threads` threads,
// converting each frame to a VideoFrame format and copying it out of the WASM heap as a
// hand-off to a VideoFrame would. Timing starts once the decoder is open, so it leaves out
// loading the module and starting its threads.

import { AVERROR_EOF, AVMEDIA_TYPE_VIDEO, createCore } from "/dist/core/index.js";
import { createDecoders } from "/test/support/decoder.js";
import { attachFileSource } from "/test/support/file-source.js";

const ready = createCore();

async function measure(core, source, openDecoder, file, threads) {
  const check = (ret, what) => {
    if (ret < 0) throw new Error(`${what}: ${core.UTF8ToString(core._sny_strerror(ret))}`);
    return ret;
  };

  source.open(file);
  const out = core._malloc(4);
  const name = core.stringToNewUTF8(file.name);
  const opened = core._sny_open(1, 1 << 22, name, out);
  const ctx = core.HEAP32[out >> 2];
  core._free(name);
  core._free(out);
  check(opened, "open");
  const pkt = core._sny_packet_alloc();
  let decoder = null;
  let module = null;
  let packed = 0;

  try {
    check(core._sny_find_stream_info(ctx), "find_stream_info");
    const count = core._sny_nb_streams(ctx);
    let stream = 0;
    while (
      stream < count &&
      core._sny_codec_type(core._sny_stream(ctx, stream)) !== AVMEDIA_TYPE_VIDEO
    )
      stream++;
    if (stream === count) throw new Error("no video stream");
    decoder = await openDecoder(ctx, stream, threads);
    const result = { frames: 0, width: 0, height: 0 };
    let capacity = 0;
    let scratch = new Uint8Array(0);

    const onFrame = (m, frame) => {
      const size = m._sny_frame_pack_size(frame);

      if (size > capacity) {
        m._free(packed);
        packed = m._malloc(size);
        capacity = size;
        scratch = new Uint8Array(size);
      }

      module = m;
      m._sny_frame_pack(frame, packed, size);
      scratch.set(m.HEAPU8.subarray(packed, packed + size));
      result.frames++;
      result.width = m._sny_frame_width(frame);
      result.height = m._sny_frame_height(frame);
    };

    const t = performance.now();

    for (;;) {
      const ret = core._sny_read(ctx, pkt);
      if (ret === AVERROR_EOF) break;
      check(ret, "read");
      if (core._sny_packet_stream(pkt) === stream) decoder.decode(pkt, onFrame);
    }

    decoder.decode(0, onFrame);
    const ms = performance.now() - t;
    return { ...result, ms, fps: result.frames / (ms / 1000) };
  } finally {
    module?._free(packed);
    decoder?.close();
    core._sny_packet_free(pkt);
    core._sny_close(ctx);
  }
}

async function run({ files, threads, dist }) {
  try {
    const core = await ready;
    core._sny_set_log_level(16);
    const source = attachFileSource(core);
    const openDecoder = createDecoders(core, { dist });
    const results = {};

    for (const file of files) {
      try {
        results[file.name] = await measure(core, source, openDecoder, file, threads);
      } catch (e) {
        results[file.name] = { error: String(e) };
      }
    }

    self.postMessage(results);
  } catch (e) {
    self.postMessage({ error: String(e?.stack ?? e) });
  }
}

self.addEventListener("message", ({ data }) => void run(data));
