// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Audio decode benchmark worker, one fresh worker per run. Message: { files }. For each
// file: open, then demux and decode its first audio stream to float planar, copying every
// frame out of the WASM heap as a hand-off to an AudioWorklet would.

import { AVERROR_EOF, AVMEDIA_TYPE_AUDIO, createCore } from "/dist/core/index.js";
import { openAudioDecoder } from "/test/support/audio-decoder.js";
import { attachFileSource } from "/test/support/file-source.js";

const ready = createCore();

function measure(core, source, file) {
  const check = (ret, what) => {
    if (ret < 0) throw new Error(`${what}: ${core.UTF8ToString(core._sny_strerror(ret))}`);
    return ret;
  };

  const t = performance.now();
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

  try {
    check(core._sny_find_stream_info(ctx), "find_stream_info");
    const count = core._sny_nb_streams(ctx);
    let stream = 0;
    while (
      stream < count &&
      core._sny_codec_type(core._sny_stream(ctx, stream)) !== AVMEDIA_TYPE_AUDIO
    )
      stream++;
    if (stream === count) throw new Error("no audio stream");
    decoder = openAudioDecoder(core, ctx, stream);
    const result = { samples: 0, channels: 0, sampleRate: 0 };
    let scratch = new Float32Array(0);

    const onFrame = (fltp) => {
      const n = core._sny_frame_samples(fltp);
      result.samples += n;
      result.channels = core._sny_frame_channels(fltp);
      result.sampleRate = core._sny_frame_sample_rate(fltp);
      if (scratch.length < n) scratch = new Float32Array(n);

      for (let c = 0; c < result.channels; c++) {
        const plane = core._sny_frame_plane(fltp, c) >> 2;
        scratch.set(core.HEAPF32.subarray(plane, plane + n));
      }
    };

    for (;;) {
      const ret = core._sny_read(ctx, pkt);
      if (ret === AVERROR_EOF) break;
      check(ret, "read");
      if (core._sny_packet_stream(pkt) === stream) decoder.decode(pkt, onFrame);
    }

    decoder.decode(0, onFrame);
    const ms = performance.now() - t;
    const seconds = result.samples / result.sampleRate;
    return { ...result, ms, realtime: seconds / (ms / 1000) };
  } finally {
    decoder?.close();
    core._sny_packet_free(pkt);
    core._sny_close(ctx);
  }
}

async function run({ files }) {
  try {
    const core = await ready;
    core._sny_set_log_level(16);
    const source = attachFileSource(core);
    const results = {};

    for (const file of files) {
      try {
        results[file.name] = measure(core, source, file);
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
