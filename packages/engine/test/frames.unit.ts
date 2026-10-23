// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The frame queue (src/frames.ts) and the compositor's fit (src/compositor.ts), in Chromium: the
// queue keeps frames in presentation order, hands out the latest one due and closes those it
// skips, and counts bytes, not frames; a frame of another shape than the canvas is centred
// with black bars, and Y′CbCr becomes the R′G′B′ FFmpeg makes of it. test/render.test.ts covers both in the browsers.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { viewMap, yuvMatrix } from "../src/compositor";
import { createFrameQueue } from "../src/frames";

function frames(...timestamps: number[]) {
  const closed: number[] = [];
  const all = timestamps.map((timestamp) => ({ timestamp, close: () => closed.push(timestamp) }));
  return { all, closed };
}

test("frames come out in presentation order, whatever order they go in", () => {
  const { all, closed } = frames(0, 66, 33, 100);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  expect(queue.take(-1)).toBeUndefined();
  expect(queue.take(0)?.timestamp).toBe(0);
  expect(queue.take(10)).toBeUndefined();
  expect(queue.take(33)?.timestamp).toBe(33);
  expect(closed).toEqual([]);
});

test("a jump hands out the latest frame due and closes the ones before it", () => {
  const { all, closed } = frames(0, 33, 66, 100);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  expect(queue.take(80)?.timestamp).toBe(66);
  expect(closed).toEqual([0, 33]);
  queue.clear();
  expect(closed).toEqual([0, 33, 100]);
});

test("the budget counts bytes, and taking frames frees them", () => {
  const { all } = frames(0, 33, 66);
  const queue = createFrameQueue(250, (f) => (f.timestamp === 66 ? 200 : 100));
  queue.push(all[0] ?? { timestamp: 0, close() {} });
  queue.push(all[1] ?? { timestamp: 0, close() {} });
  expect(queue.full()).toBe(false);
  queue.push(all[2] ?? { timestamp: 0, close() {} });
  expect(queue.full()).toBe(true);
  queue.take(33);
  expect(queue.full()).toBe(false);
});

test("a frame wider than the canvas is centred between bars above and below", () => {
  const map = new Float32Array(8);
  // 200 × 100 into a square: the frame takes the middle half of the height.
  viewMap(map, [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30], 200, 100, 100, 100);
  const at = (x: number, y: number) => [
    (map[0] ?? 0) * x + (map[2] ?? 0) * y + (map[4] ?? 0),
    (map[1] ?? 0) * x + (map[3] ?? 0) * y + (map[5] ?? 0),
  ];
  // Clip space has y up, texture coordinates y down.
  expect(at(-1, 0.5)).toEqual([0, 0]);
  expect(at(1, -0.5)).toEqual([1, 1]);
  expect(at(0, 1)[1]).toBeLessThan(0);
});

test("dropping before a time keeps the latest frame due then, and the later ones", () => {
  const { all, closed } = frames(0, 33, 66, 100);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  queue.drop(80);
  expect(closed).toEqual([0, 33]);
  expect(queue.take(80)?.timestamp).toBe(66);
  queue.drop(80);
  expect(queue.take(100)?.timestamp).toBe(100);
  expect(closed).toEqual([0, 33]);
});

// R′G′B′ in 8-bit levels of plane values `yuv` at `depth` bits, by yuvMatrix.
function convert(space: VideoColorSpaceInit, depth: number, yuv: number[]) {
  const m = new Float32Array(16);
  yuvMatrix(m, space, depth);
  const [y = 0, u = 0, v = 0] = yuv;
  return [0, 1, 2].map((i) => {
    const level = (m[i] ?? 0) * y + (m[4 + i] ?? 0) * u + (m[8 + i] ?? 0) * v + (m[12 + i] ?? 0);
    return Math.round(Math.min(Math.max(level, 0), 1) * 255);
  });
}

test("Y′CbCr that states no colour converts as FFmpeg's: limited range, BT.601", () => {
  // A pixel of test/fixtures/mpeg2-aac.mov, which FFmpeg shows as 0, 255, 5.
  expect(convert({}, 8, [145, 56, 33])).toEqual([0, 255, 5]);
  expect(convert({}, 8, [235, 128, 128])).toEqual([255, 255, 255]);
  expect(convert({}, 8, [16, 128, 128])).toEqual([0, 0, 0]);
});

// Not from FFmpeg: worked out from the matrices and ranges of H.273.
test("the stated matrix, range and bit depth change the conversion", () => {
  expect(convert({ matrix: "bt709" }, 8, [145, 56, 33])).toEqual([0, 216, 0]);
  expect(convert({ fullRange: true }, 8, [255, 128, 128])).toEqual([255, 255, 255]);
  expect(convert({ matrix: "bt709" }, 10, [940, 512, 512])).toEqual([255, 255, 255]);
  expect(convert({ matrix: "bt709" }, 10, [64, 512, 512])).toEqual([0, 0, 0]);
  // Planar RGB is G, B, R.
  expect(convert({ matrix: "rgb", fullRange: true }, 8, [255, 0, 128])).toEqual([128, 255, 0]);
  // RGB that states no range is full, as FFmpeg takes it.
  expect(convert({ matrix: "rgb" }, 8, [255, 0, 128])).toEqual([128, 255, 0]);
  expect(convert({ matrix: "rgb", fullRange: false }, 8, [235, 16, 16])).toEqual([0, 255, 0]);
});

test("next hands out the earliest frame, due or not", () => {
  const { all, closed } = frames(66, 0, 33);
  const queue = createFrameQueue(1000, () => 1);
  for (const f of all) queue.push(f);
  expect(queue.first()?.timestamp).toBe(0);
  expect(queue.next()?.timestamp).toBe(0);
  expect(queue.next()?.timestamp).toBe(33);
  expect(queue.count()).toBe(1);
  expect(queue.next()?.timestamp).toBe(66);
  expect(queue.next()).toBeUndefined();
  expect(closed).toEqual([]);
});
