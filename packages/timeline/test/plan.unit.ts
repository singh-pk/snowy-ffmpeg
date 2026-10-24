// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render plan (src/plan.ts), in Chromium: a range cut into segments where the layers change,
// layers in compositing order, keyframes at their times on the timeline, and times in
// microseconds.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { plan } from "../src/plan";
import { FLICKS_PER_SECOND } from "../src/time";
import { asset, at, audio, clip, id, SECOND, sequence, setUp, video } from "./support/project";

const MICROS = 1_000_000;

// A keyframe on a clip's opacity.
const opacity = (target: string, when: number, value: number) => ({
  op: "keyframe.set" as const,
  keyframe: { target, param: "video.opacity", at: when, value, ease: "linear" as const },
});

test("a storyline plays its clips one after another, in microseconds", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1"), in: 24_000 }));
  const found = plan(project, sequence, 0, 2 * SECOND);
  expect(found?.sequence.rate).toEqual([24, 1]);
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
  const layers = found?.segments.map(({ from, video: shown }) => [from, shown.map((l) => l.clip)]);
  expect(layers).toEqual([
    [0, [storyline]],
    [MICROS / 2, [storyline, id(3, 0)]],
    [MICROS, [storyline, id(3, 0)]],
    [1.5 * MICROS, [storyline]],
  ]);
  // A layer that plays on is the same object in the next segment.
  expect(found?.segments[1]?.video[1]).toBe(found?.segments[2]?.video[1]);
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

test("video roles composite in order, each lane from the lowest up", () => {
  const { project, apply } = setUp();
  apply({
    op: "role.add",
    role: { sequence, name: "Titles", kind: "video", color: "#ffcc00", order: "a2" },
  });
  const titles = id(2, 0);
  const origin = { origin: sequence, at: 0 };
  apply(
    clip({ anchor: at("a0") }),
    clip({ anchor: origin, role: titles }),
    clip({ anchor: origin }),
    clip({ anchor: origin }),
  );
  const shown = plan(project, sequence, 0, SECOND)?.segments[0]?.video.map((l) => l.clip);
  expect(shown).toEqual([id(3, 0), id(3, 2), id(3, 3), id(3, 1)]);
});

test("keyframes are at their times on the timeline, in time order at any speed", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0"), in: 24_000, speed: [2, 1] }),
    clip({ anchor: at("a1"), in: 48_000, speed: [-1, 1] }),
  );
  const forwards = id(2, 0);
  const backwards = id(2, 1);
  apply(
    opacity(forwards, 48_000, 0),
    {
      op: "effect.add",
      effect: {
        clip: forwards,
        kind: "color.wheels",
        position: "a0",
        enabled: true,
        params: { amount: 1 },
      },
    },
    {
      op: "effect.add",
      effect: { clip: forwards, kind: "blur", position: "a1", enabled: false, params: {} },
    },
    opacity(backwards, 24_000, 0),
    opacity(backwards, 36_000, 1),
  );
  apply({
    op: "keyframe.set",
    keyframe: { target: id(3, 1), param: "amount", at: 72_000, value: 0.5, ease: "hold" },
  });
  const found = plan(project, sequence, 0, 2 * SECOND);
  const [first] = found?.segments[0]?.video ?? [];
  expect(first?.opacity).toEqual({ keyframes: [{ at: MICROS / 2, value: 0, ease: "linear" }] });
  expect(first?.effects).toEqual([
    {
      id: id(3, 1),
      kind: "color.wheels",
      params: { amount: { keyframes: [{ at: MICROS, value: 0.5, ease: "hold" }] } },
    },
  ]);
  const [second] = found?.segments[1]?.video ?? [];
  expect(second?.opacity).toEqual({
    keyframes: [
      { at: 1.5 * MICROS, value: 1, ease: "linear" },
      { at: 2 * MICROS, value: 0, ease: "linear" },
    ],
  });
});

test("generators and compound clips play in flicks, with their parameters animated", () => {
  const { project, apply } = setUp();
  apply({
    op: "sequence.add",
    sequence: { name: "Inner", rate: [24, 1], width: 1280, height: 720, sampleRate: 48_000 },
  });
  const inner = id(2, 0);
  apply(
    clip({ anchor: at("a0"), source: { generator: "solid", params: { level: 1 } }, in: 0 }),
    clip({ anchor: at("a1"), source: { sequence: inner }, in: 0 }),
  );
  apply({
    op: "keyframe.set",
    keyframe: { target: id(3, 0), param: "source.params.level", at: 0, value: 0, ease: "linear" },
  });
  const found = plan(project, sequence, 0, 2 * SECOND);
  const [solid] = found?.segments[0]?.video ?? [];
  expect(solid?.timeBase).toEqual([1, FLICKS_PER_SECOND]);
  expect(solid?.source).toEqual({
    generator: "solid",
    params: { level: { keyframes: [{ at: 0, value: 0, ease: "linear" }] } },
  });
  expect(found?.segments[1]?.video[0]?.source).toEqual({ sequence: inner });
});

test("a connected clip whose clip is removed plays where that clip was", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: at("a0") }), clip({ anchor: at("a1") }));
  apply(clip({ anchor: { clip: id(2, 1), at: 0 } }));
  apply({ op: "item.remove", id: id(2, 0) });
  const found = plan(project, sequence, 0, SECOND);
  expect(found?.segments[0]?.video.map((l) => l.clip)).toEqual([id(2, 1), id(3, 0)]);
});

test("a range part way through a clip keeps the clip's start, and names what starts at its end", () => {
  const { project, apply } = setUp();
  apply(
    clip({ anchor: at("a0") }),
    clip({ anchor: at("a1"), enabled: false }),
    clip({ anchor: at("a2") }),
    clip({ anchor: { origin: sequence, at: SECOND / 2 }, duration: 0 }),
  );
  const found = plan(project, sequence, SECOND / 2, SECOND);
  expect(found?.segments).toHaveLength(1);
  expect(found?.segments[0]?.from).toBe(MICROS / 2);
  expect(found?.segments[0]?.video.map((l) => [l.clip, l.start])).toEqual([[id(2, 0), 0]]);
  expect(found?.next).toEqual([]);
  // The disabled clip plays nothing, and the next one starts after it.
  expect(plan(project, sequence, SECOND, 2 * SECOND)?.segments[0]?.video).toEqual([]);
  const ahead = plan(project, sequence, SECOND, 2 * SECOND)?.next;
  expect(ahead?.map((l) => [l.clip, l.start])).toEqual([[id(2, 2), 2 * MICROS]]);
  expect(plan(project, sequence, SECOND, SECOND)?.segments).toEqual([]);
  expect(() => plan(project, sequence, SECOND, 0)).toThrow(RangeError);
  expect(plan(project, video, 0, SECOND)).toBe(undefined);
});
