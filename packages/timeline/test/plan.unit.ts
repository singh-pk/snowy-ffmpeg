// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render plan (src/plan.ts), in Chromium: a range cut into segments where the layers change,
// layers in compositing order, keyframes at their times on the timeline, and times in
// microseconds.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { plan } from "../src/plan";
import { asset, at, audio, clip, id, SECOND, sequence, setUp, video } from "./support/project";

const MICROS = 1_000_000;

test("a storyline plays its clips one after another, in microseconds", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1"), in: 24_000 }));
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(found?.segments.map(({ from, to }) => [from, to])).toEqual([
    [0, MICROS],
    [MICROS, 2 * MICROS],
  ]);
  expect(found?.segments[1]?.video).toEqual([
    {
      clip: id(2, 1),
      source: { asset, stream: 0 },
      in: 24_000,
      timeBase: [1, 24_000],
      start: MICROS,
      speed: [1, 1],
      effects: [],
      opacity: 1,
      blend: "normal",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    },
  ]);
  expect(found?.segments[1]?.audio).toEqual([]);
});

test("connected clips cut the range where they start and end, above the storyline", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0"), duration: 2 * SECOND }));
  const storyline = id(2, 0);
  apply(
    clip({ anchor: { clip: storyline, at: 12_000 }, duration: SECOND }),
    clip({
      anchor: { origin: sequence, at: SECOND },
      source: { asset, stream: 1 },
      role: audio,
      audio: { gainDb: -6, pan: 0.5, fadeIn: SECOND / 4, fadeOut: SECOND / 2 },
    }),
  );
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(
    found?.segments.map(({ from, video: layers }) => [from, layers.map((l) => l.clip)]),
  ).toEqual([
    [0, [storyline]],
    [MICROS / 2, [storyline, id(3, 0)]],
    [MICROS, [storyline, id(3, 0)]],
    [1.5 * MICROS, [storyline]],
  ]);
  const music = found?.segments[2]?.audio[0];
  expect(music?.clip).toBe(id(3, 1));
  expect(music?.bus).toBe(audio);
  expect(music?.timeBase).toEqual([1, 48_000]);
  expect([music?.gainDb, music?.pan, music?.fadeIn, music?.fadeOut]).toEqual([
    -6,
    0.5,
    1.25 * MICROS,
    1.5 * MICROS,
  ]);
});

test("keyframes are at their times on the timeline, through the clip's in-point and speed", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0"), in: 24_000, speed: [2, 1] }));
  const played = id(2, 0);
  apply(
    {
      op: "keyframe.set",
      keyframe: { target: played, param: "video.opacity", at: 48_000, value: 0, ease: "linear" },
    },
    {
      op: "effect.add",
      effect: {
        clip: played,
        kind: "color.wheels",
        position: "a0",
        enabled: true,
        params: { amount: 1 },
      },
    },
    {
      op: "effect.add",
      effect: { clip: played, kind: "blur", position: "a1", enabled: false, params: {} },
    },
  );
  apply({
    op: "keyframe.set",
    keyframe: { target: id(3, 1), param: "amount", at: 72_000, value: 0.5, ease: "hold" },
  });
  const [layer] = plan(project, sequence, 0, SECOND)?.segments[0]?.video ?? [];
  expect(layer?.opacity).toEqual({ keyframes: [{ at: MICROS / 2, value: 0, ease: "linear" }] });
  expect(layer?.effects).toEqual([
    {
      id: id(3, 1),
      kind: "color.wheels",
      params: { amount: { keyframes: [{ at: MICROS, value: 0.5, ease: "hold" }] } },
    },
  ]);
});

test("a range part way through a clip keeps the clip's start, and names what comes next", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0") }),
    clip({ anchor: at("a1"), source: { asset, stream: 0 }, enabled: false }),
    clip({ anchor: at("a2") }),
  );
  const found = plan(project, sequence, SECOND / 2, SECOND);
  expect(found?.segments).toHaveLength(1);
  expect(found?.segments[0]?.from).toBe(MICROS / 2);
  expect(found?.segments[0]?.video[0]?.start).toBe(0);
  expect(found?.next).toEqual([]);
  // The disabled clip plays nothing, and the next one is after it.
  expect(plan(project, sequence, SECOND, 2 * SECOND)?.segments[0]?.video).toEqual([]);
  expect(plan(project, sequence, SECOND, 2 * SECOND)?.next).toEqual([{ asset, stream: 0 }]);
  expect(plan(project, video, 0, SECOND)).toBe(undefined);
});
