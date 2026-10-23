// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// A Bun worker that writes `count` packets into a ring (test/ring.test.ts): packet i has
// size(i) bytes, byte j of it is (i + j) & 255, and its pts is i. Posts how many it wrote
// once it ends the ring or the consumer closes it.

import { createProducer } from "../../src/ring";

declare const self: Worker;

export const size = (i: number) => (i * 7919) % 3001;

self.addEventListener(
  "message",
  ({ data }: MessageEvent<{ ring: SharedArrayBuffer; count: number }>) => {
    const producer = createProducer(data.ring);
    const src = new Uint8Array(3001 + 256);
    for (const [j] of src.entries()) src[j] = j & 255;
    let written = 0;

    for (; written < data.count; written++) {
      const n = size(written);
      if (
        !producer.write(1, written & 1, BigInt(written), BigInt(-written), n, src, written & 255, n)
      )
        break;
    }

    if (written === data.count) producer.end();
    self.postMessage(written);
  },
);
