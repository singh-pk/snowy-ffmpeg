// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Where connected items go (src/layout.ts), in Chromium: an item anchored to a clip stays on the
// same moment of its media through a head trim or a speed change, video snaps to a frame, and
// items of a role keep the lane they prefer unless it is taken, then stack upwards.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { assignLanes, clipAnchorStart, originAnchorStart } from "../src/layout";
import { FLICKS_PER_SECOND, frameFlicks } from "../src/time";

const SECOND = FLICKS_PER_SECOND;
// A clip of a 1/48 s time base at full speed, starting 10 s into the sequence, from 2 s into its media.
const clip = {
  start: 10 * SECOND,
  in: 96,
  speed: [1, 1] as [number, number],
  timeBase: [1, 48] as [number, number],
};

test("an item anchored to a clip starts at the clip's start plus its source point's offset", () => {
  expect(clipAnchorStart(clip, 96 + 48)).toBe(11 * SECOND);
  expect(clipAnchorStart(clip, 96)).toBe(10 * SECOND);
});

test("a head trim moves the clip's in-point and start together, and the item stays on its moment", () => {
  // Trimming 1 s off the head: in moves 48 units later, and the clip still starts at 10 s.
  const trimmed = { ...clip, in: 96 + 48 };
  expect(clipAnchorStart(trimmed, 96 + 96)).toBe(11 * SECOND);
  expect(clipAnchorStart(clip, 96 + 96)).toBe(12 * SECOND);
});

test("a source point outside the clip puts the item before or after it", () => {
  expect(clipAnchorStart(clip, 48)).toBe(9 * SECOND);
});

test("speed and reverse change how far into the clip a source point plays", () => {
  expect(clipAnchorStart({ ...clip, speed: [2, 1] }, 96 + 48)).toBe(10.5 * SECOND);
  expect(clipAnchorStart({ ...clip, speed: [-1, 1] }, 96 - 48)).toBe(11 * SECOND);
});

test("a reversed clip starts at its in-point and plays down from it", () => {
  // In at 2 s, playing backwards: the moment at 1.5 s comes half a second into the clip, and
  // 2.5 s, past the in-point, half a second before it.
  const reversed = { ...clip, speed: [-1, 1] as [number, number] };
  expect(clipAnchorStart(reversed, 72)).toBe(10.5 * SECOND);
  expect(clipAnchorStart(reversed, 120)).toBe(9.5 * SECOND);
});

test("video snaps down to its sequence's frame; audio keeps its flick", () => {
  const frame = frameFlicks([24, 1]);
  const between = { ...clip, timeBase: [1, 15_360] as [number, number], in: 0, start: 0 };
  // 1/15360 s is 45,938 flicks once rounded: inside the first frame.
  expect(clipAnchorStart(between, 1)).toBe(45_938);
  expect(clipAnchorStart(between, 1, [24, 1])).toBe(0);
  expect(originAnchorStart(frame + 5, [24, 1])).toBe(frame);
  expect(originAnchorStart(frame + 5)).toBe(frame + 5);
});

test("each item keeps the lane it prefers while it is free", () => {
  const lanes = assignLanes([
    { id: "a", start: 0, duration: 10, lane: 0 },
    { id: "b", start: 10, duration: 10, lane: 0 },
    { id: "c", start: 5, duration: 10, lane: 2 },
  ]);
  expect(Object.fromEntries(lanes)).toEqual({ a: 0, b: 0, c: 2 });
});

test("an item whose lane is taken goes in the nearest free lane above", () => {
  const lanes = assignLanes([
    { id: "a", start: 0, duration: 10, lane: 0 },
    { id: "b", start: 0, duration: 10, lane: 1 },
    { id: "c", start: 5, duration: 10, lane: 0 },
    { id: "d", start: 9, duration: 1, lane: 0 },
  ]);
  expect(Object.fromEntries(lanes)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
});

test("two items placed in the same spot both stay, stacked by id, whatever order they come in", () => {
  const items = [
    { id: "y", start: 0, duration: 10, lane: 0 },
    { id: "x", start: 0, duration: 10, lane: 0 },
  ];
  expect(Object.fromEntries(assignLanes(items))).toEqual({ x: 0, y: 1 });
  expect(Object.fromEntries(assignLanes(items.toReversed()))).toEqual({ x: 0, y: 1 });
});

test("times and durations are exact flicks, and durations aren't negative", () => {
  expect(() => assignLanes([{ id: "a", start: 0, duration: -1, lane: 0 }])).toThrow(RangeError);
  expect(() => assignLanes([{ id: "a", start: 0.5, duration: 1, lane: 0 }])).toThrow(RangeError);
  expect(() => assignLanes([{ id: "a", start: 2 ** 53, duration: 1, lane: 0 }])).toThrow(
    RangeError,
  );
  expect(() => originAnchorStart(0.5)).toThrow(RangeError);
  expect(() => clipAnchorStart({ ...clip, start: Number.MAX_SAFE_INTEGER }, 96 + 48)).toThrow(
    RangeError,
  );
});

test("a lane is a non-negative integer", () => {
  expect(() => assignLanes([{ id: "a", start: 0, duration: 1, lane: -1 }])).toThrow(RangeError);
  expect(() => assignLanes([{ id: "a", start: 0, duration: 1, lane: 0.5 }])).toThrow(RangeError);
});
