// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Bench adapter for mediabunny 1.61.6 (pure TS demuxers, BlobSource I/O).

import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
} from "/node_modules/mediabunny/dist/bundles/mediabunny.min.mjs";

export async function create() {
  const state = { input: null, tracks: [], videoSink: null };

  // Comparable to avformat_find_stream_info: track list plus every decoder config.
  async function open(file) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const tracks = await input.getTracks();
    for (const t of tracks) await t.getDecoderConfig();
    state.input = input;
    state.tracks = tracks;
    state.videoSink = new EncodedPacketSink(tracks.find((t) => t.isVideoTrack()));
  }

  // Track by track (mediabunny has no interleaved reader).
  async function demux() {
    let packets = 0;
    let bytes = 0;

    for (const t of state.tracks) {
      for await (const p of new EncodedPacketSink(t).packets()) {
        packets++;
        bytes += p.data.length;
      }
    }

    return { packets, bytes };
  }

  async function seek(t) {
    const packet = await state.videoSink.getKeyPacket(t);
    return packet.timestamp;
  }

  async function close() {
    state.input?.dispose?.();
  }

  return { open, demux, seek, close, io: () => null, heapBytes: () => null };
}
