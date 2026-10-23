// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// How far a decoder has decoded (src/decoding.ts), in Chromium: frames out in presentation or in
// decode order, a packet that makes no frame, a frame that never comes, and the end. The
// browser tests cover it with every fixture, decoded for real.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { createDecodeTracker } from "../src/decoding";

// A group of pictures in decode order, as [pts, dts]: I0 P3 B1 B2.
const GOP = [
  [0, -1],
  [3, 0],
  [1, 1],
  [2, 2],
] as const;

test("frames out in presentation order count up as they come", () => {
  const tracker = createDecodeTracker();
  expect(tracker.decodedTo()).toBe(-Infinity);
  for (const [pts, dts] of GOP) tracker.feed(pts, dts, true);
  tracker.out(0);
  expect(tracker.decodedTo()).toBe(0);
  tracker.out(1);
  tracker.out(2);
  expect(tracker.decodedTo()).toBe(2);
  tracker.out(3);
  expect(tracker.decodedTo()).toBe(2);
  tracker.end();
  expect(tracker.decodedTo()).toBe(3);
});

test("frames out in decode order count only up to the earliest still to come", () => {
  const tracker = createDecodeTracker();
  tracker.feed(0, -1, true);
  tracker.out(0);
  tracker.feed(3, 0, true);
  tracker.out(3);
  // B1 and B2 are not fed yet, and come before 3.
  expect(tracker.decodedTo()).toBe(0);
  tracker.feed(1, 1, true);
  expect(tracker.decodedTo()).toBe(0);
  tracker.out(1);
  expect(tracker.decodedTo()).toBe(1);
  tracker.feed(2, 2, true);
  tracker.out(2);
  expect(tracker.decodedTo()).toBe(2);
});

test("a packet that makes no frame is not waited for, even at the same time as a frame", () => {
  const tracker = createDecodeTracker();
  tracker.feed(0, 0, true);
  // A VP8 alt-ref frame shares the time of the frame after it.
  tracker.feed(33, 33, false);
  tracker.feed(33, 33, true);
  tracker.feed(67, 67, true);
  tracker.out(0);
  tracker.out(33);
  tracker.out(67);
  expect(tracker.decodedTo()).toBe(67);
});

test("a frame that never comes is waited for until one fed more than held after it comes", () => {
  const tracker = createDecodeTracker(2);
  for (let i = 0; i < 5; i++) tracker.feed(i, i, true);
  tracker.out(0);
  tracker.out(2);
  tracker.out(3);
  // Packet 1 is two packets before 3: it may still come.
  expect(tracker.decodedTo()).toBe(0);
  tracker.out(4);
  expect(tracker.decodedTo()).toBe(4);
});

test("frames at the same time come out one for each packet", () => {
  const tracker = createDecodeTracker();
  tracker.feed(0, 0, true);
  tracker.feed(0, 1, true);
  tracker.out(0);
  expect(tracker.decodedTo()).toBe(-1);
  tracker.out(0);
  expect(tracker.decodedTo()).toBe(0);
});

test("a frame out after it is no longer waited for does not take the count back", () => {
  const tracker = createDecodeTracker(1);
  for (let i = 0; i < 3; i++) tracker.feed(i, i, true);
  tracker.out(2);
  expect(tracker.decodedTo()).toBe(0);
  tracker.out(0);
  expect(tracker.decodedTo()).toBe(0);
});
