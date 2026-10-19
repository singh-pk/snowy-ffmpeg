// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// A Bun worker that writes `count` stereo frames into a PCM ring (test/pcm.test.ts), CHUNK at
// a time: channel 0 of frame i holds i + 1, never silence, and channel 1 its negative. Posts
// how many it wrote once it has written them all or the consumer closes the ring.

import { createPcmProducer } from "../../src/pcm";

declare const self: Worker;

const CHUNK = 300;

self.addEventListener(
  "message",
  ({ data }: MessageEvent<{ ring: SharedArrayBuffer; count: number }>) => {
    const producer = createPcmProducer(data.ring);
    const src = new Float32Array(CHUNK * 2);
    let written = 0;

    while (written < data.count) {
      const n = Math.min(CHUNK, data.count - written);

      for (let i = 0; i < n; i++) {
        src[2 * i] = written + i + 1;
        src[2 * i + 1] = -(written + i + 1);
      }

      if (!producer.write(src, 0, n)) break;
      written += n;
    }

    self.postMessage(written);
  },
);
