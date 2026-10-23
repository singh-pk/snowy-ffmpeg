// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The frame queue (src/frames.ts) and the compositor's fit (src/compositor.ts), in Chromium: the
// queue keeps frames in presentation order, hands out the latest one due and closes those it
// skips, and counts bytes, not frames; a frame of another shape than the canvas is centred
// with black bars. test/render.test.ts covers both in the browsers.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { viewMap } from "../src/compositor";
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
