// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Splitting, joining, effects and keyframes (src/project.ts), in Chromium: a split hands what is
// past it to the second piece without moving anything, a join takes it back, and effects and
// keyframes are checked against what they change.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { at, clip, FRAME, id, SECOND, sequence, setUp, type Op } from "./support/project";

const reasons = (result: { skipped: { index: number; reason: string }[] }) =>
  result.skipped.map(({ index, reason }) => [index, reason]);

// One field of an item, whatever its kind.
const field = (item: object | undefined, key: string) =>
  Object.entries(item ?? {}).find(([name]) => name === key)?.[1];

const keyframe = (target: string, param: string, when: number, value: number): Op => ({
  op: "keyframe.set",
  keyframe: { target, param, at: when, value, ease: "linear" },
});

const effect = (clipId: string, position: string, params = {}): Op => ({
  op: "effect.add",
  effect: { clip: clipId, kind: "color.wheels", position, enabled: true, params },
});

test("a split leaves two clips that play on from each other", () => {
  const { project, apply } = setUp();
  apply(clip({ duration: 2 * SECOND }), clip({ anchor: at("a1") }));
  const result = apply({ op: "clip.split", id: id(2, 0), at: SECOND / 2 });
  const piece = id(result.seq, 0);
  expect(reasons(result)).toEqual([]);
  expect(result.changed).toEqual([id(2, 0), piece]);
  expect(project.storyline(sequence)).toEqual([
    { id: id(2, 0), start: 0, duration: SECOND / 2 },
    { id: piece, start: SECOND / 2, duration: (3 * SECOND) / 2 },
    { id: id(2, 1), start: 2 * SECOND, duration: SECOND },
  ]);
  // Half a second into a 1/24000 stream.
  expect(field(project.item(piece), "in")).toBe(12_000);
});

test("a split hands what is past it to the second piece, and nothing moves", () => {
  const { project, apply } = setUp();
  apply(
    clip({ duration: 2 * SECOND }),
    clip({ anchor: { clip: id(2, 0), at: 6000 }, lane: 1 }),
    clip({ anchor: { clip: id(2, 0), at: 36_000 }, lane: 1 }),
    {
      op: "item.add",
      item: { kind: "transition", cut: id(2, 0), duration: FRAME, effect: "dissolve", params: {} },
    },
    clip({ anchor: at("a1") }),
  );
  apply(keyframe(id(2, 0), "video.opacity", 0, 1), keyframe(id(2, 0), "video.opacity", 30_000, 0));
  const starts = () => [id(2, 1), id(2, 2), id(2, 3)].map((each) => project.start(each));
  const before = starts();
  const split = apply({ op: "clip.split", id: id(2, 0), at: SECOND });
  const piece = id(split.seq, 0);
  expect(starts()).toEqual(before);
  expect(split.changed).toEqual([id(2, 0), piece, id(2, 2), id(2, 3)]);
  expect(field(project.item(id(2, 1)), "anchor")).toEqual({ clip: id(2, 0), at: 6000 });
  expect(field(project.item(id(2, 2)), "anchor")).toEqual({ clip: piece, at: 36_000 });
  expect(field(project.item(id(2, 3)), "cut")).toBe(piece);
  expect(project.keyframes(id(2, 0)).map((each) => each.at)).toEqual([0]);
  expect(project.keyframes(piece).map((each) => [each.target, each.at])).toEqual([[piece, 30_000]]);

  // Joining takes it all back.
  const join = apply({ op: "clip.join", id: id(2, 0), next: piece });
  expect(reasons(join)).toEqual([]);
  expect(starts()).toEqual(before);
  expect(project.item(id(2, 0))?.duration).toBe(2 * SECOND);
  expect(project.item(piece)?.removed).toBe(true);
  expect(field(project.item(id(2, 2)), "anchor")).toEqual({ clip: id(2, 0), at: 36_000 });
  expect(field(project.item(id(2, 3)), "cut")).toBe(id(2, 0));
  expect(project.keyframes(id(2, 0)).map((each) => [each.target, each.at])).toEqual([
    [id(2, 0), 0],
    [id(2, 0), 30_000],
  ]);
  expect(project.storyline(sequence).map((placed) => placed.duration)).toEqual([
    2 * SECOND,
    SECOND,
  ]);
});

test("a split must fall inside a live clip", () => {
  const { apply } = setUp();
  apply(clip(), {
    op: "item.add",
    item: { kind: "gap", anchor: at("a1"), duration: SECOND },
  });
  const result = apply(
    { op: "clip.split", id: id(2, 0), at: 0 },
    { op: "clip.split", id: id(2, 0), at: SECOND },
    { op: "clip.split", id: id(2, 1), at: (3 * SECOND) / 2 },
    { op: "clip.split", id: id(9, 9), at: 1 },
  );
  expect(reasons(result)).toEqual([
    [0, "stale"],
    [1, "stale"],
    [2, "structural"],
    [3, "stale"],
  ]);
});

test("a reversed clip splits at the source point it has reached, counting down", () => {
  const { project, apply } = setUp();
  apply(
    clip({ speed: [-1, 1], in: 48_000 }),
    clip({ anchor: { clip: id(2, 0), at: 40_000 }, lane: 1 }),
    clip({ anchor: { clip: id(2, 0), at: 30_000 }, lane: 1 }),
  );
  const { seq } = apply({ op: "clip.split", id: id(2, 0), at: SECOND / 2 });
  const piece = id(seq, 0);
  expect(field(project.item(piece), "in")).toBe(36_000);
  expect(field(project.item(id(2, 1)), "anchor")).toEqual({ clip: id(2, 0), at: 40_000 });
  expect(field(project.item(id(2, 2)), "anchor")).toEqual({ clip: piece, at: 30_000 });
  expect(reasons(apply({ op: "clip.join", id: id(2, 0), next: piece }))).toEqual([]);
});

test("a connected clip splits on its own anchor", () => {
  const { project, apply } = setUp();
  apply(clip({ anchor: { origin: sequence, at: SECOND }, duration: 2 * SECOND }));
  const { seq } = apply({ op: "clip.split", id: id(2, 0), at: 2 * SECOND });
  const piece = id(seq, 0);
  expect(field(project.item(piece), "anchor")).toEqual({ origin: sequence, at: 2 * SECOND });
  expect(project.start(piece)).toBe(2 * SECOND);
  expect(reasons(apply({ op: "clip.join", id: id(2, 0), next: piece }))).toEqual([]);
  expect(project.item(id(2, 0))?.duration).toBe(2 * SECOND);
});

test("a split's fades stay at the ends, and a join puts them back", () => {
  const { project, apply } = setUp();
  apply(
    clip({
      duration: 2 * SECOND,
      audio: { gainDb: 0, pan: 0, fadeIn: FRAME, fadeOut: 2 * FRAME },
    }),
  );
  const { seq } = apply({ op: "clip.split", id: id(2, 0), at: SECOND });
  const piece = id(seq, 0);

  const fades = (each: string) => {
    const item = project.item(each);
    return item?.kind === "clip" ? [item.audio?.fadeIn, item.audio?.fadeOut] : [];
  };

  expect(fades(id(2, 0))).toEqual([FRAME, 0]);
  expect(fades(piece)).toEqual([0, 2 * FRAME]);
  apply({ op: "clip.join", id: id(2, 0), next: piece });
  expect(fades(id(2, 0))).toEqual([FRAME, 2 * FRAME]);
});

test("only pieces of one clip that still meet join", () => {
  const { apply } = setUp();
  apply(clip({ duration: 2 * SECOND }), clip({ anchor: at("a5") }));
  const { seq } = apply({ op: "clip.split", id: id(2, 0), at: SECOND });
  const piece = id(seq, 0);
  apply({ op: "item.set", id: piece, path: "in", value: 25_000 });
  const result = apply(
    { op: "clip.join", id: id(2, 0), next: piece },
    { op: "clip.join", id: piece, next: id(2, 1) },
    { op: "clip.join", id: id(2, 0), next: id(2, 0) },
    { op: "item.set", id: piece, path: "in", value: 24_000 },
    { op: "clip.join", id: piece, next: id(2, 0) },
    { op: "clip.join", id: id(2, 0), next: piece },
  );
  expect(reasons(result)).toEqual([
    [0, "stale"],
    [1, "stale"],
    [2, "malformed"],
    [4, "stale"],
  ]);
});

test("pieces of different media don't join", () => {
  const { apply } = setUp();
  apply(clip(), clip({ anchor: at("a1"), in: 24_000, source: { generator: "solid", params: {} } }));
  expect(reasons(apply({ op: "clip.join", id: id(2, 0), next: id(2, 1) }))).toEqual([
    [0, "structural"],
  ]);
});

test("a clip's effects are in chain order, and change only as their schema allows", () => {
  const { project, apply } = setUp();
  apply(clip());
  const { seq } = apply(
    effect(id(2, 0), "a1", { amount: 0.5 }),
    effect(id(2, 0), "a0"),
    effect(id(9, 9), "a0"),
  );
  expect(project.effects(id(2, 0)).map((each) => each.id)).toEqual([id(seq, 1), id(seq, 0)]);
  const result = apply(
    { op: "effect.set", id: id(seq, 0), path: "params.amount", value: 0.75 },
    { op: "effect.set", id: id(seq, 0), path: "params.amount", value: "high" },
    { op: "effect.set", id: id(seq, 0), path: "kind", value: "audio.eq" },
    { op: "effect.set", id: id(seq, 0), path: "position", value: 5 },
    { op: "effect.remove", id: id(seq, 1) },
    { op: "effect.remove", id: id(seq, 1) },
  );
  expect(reasons(result)).toEqual([
    [1, "malformed"],
    [2, "malformed"],
    [3, "malformed"],
    [5, "stale"],
  ]);
  expect(project.effects(id(2, 0))).toEqual([
    {
      id: id(seq, 0),
      clip: id(2, 0),
      kind: "color.wheels",
      position: "a1",
      enabled: true,
      params: { amount: 0.75 },
    },
  ]);
});

test("a keyframe animates a parameter or a field of its type, and setting one again replaces it", () => {
  const { project, apply } = setUp();
  apply(clip());
  const { seq } = apply(effect(id(2, 0), "a0", { amount: 0.5, mode: "soft" }));
  const wheels = id(seq, 0);
  const result = apply(
    keyframe(wheels, "amount", 0, 0),
    keyframe(wheels, "amount", 0, 1),
    keyframe(wheels, "mode", 0, 1),
    keyframe(wheels, "missing", 0, 1),
    keyframe(id(2, 0), "video.transform.x", 12_000, 10),
    keyframe(id(2, 0), "duration", 0, 10),
    keyframe(id(2, 0), "audio.fadeIn", 0, -1),
    keyframe(id(9, 9), "video.opacity", 0, 1),
  );
  expect(reasons(result)).toEqual([
    [2, "malformed"],
    [3, "stale"],
    [5, "malformed"],
    [6, "malformed"],
    [7, "stale"],
  ]);
  expect(project.keyframes(wheels).map((each) => each.value)).toEqual([1]);
  const removed = apply(
    { op: "keyframe.remove", target: id(2, 0), param: "video.transform.x", at: 12_000 },
    { op: "keyframe.remove", target: id(2, 0), param: "video.transform.x", at: 12_000 },
  );
  expect(reasons(removed)).toEqual([[1, "stale"]]);
  expect(project.keyframes(id(2, 0))).toEqual([]);
});

test("an effect or keyframe redraws only its clip", () => {
  const { apply } = setUp();
  apply(clip(), clip({ anchor: at("a1") }));
  const { seq, ranges } = apply(effect(id(2, 1), "a0", { amount: 0.5 }));
  expect(ranges.get(sequence)).toEqual({ from: SECOND, to: 2 * SECOND });
  const keyed = apply(keyframe(id(seq, 0), "amount", 0, 1));
  expect(keyed.ranges.get(sequence)).toEqual({ from: SECOND, to: 2 * SECOND });
});

test("reverting and branching are left to the history", () => {
  const { apply } = setUp();
  const result = apply(
    { op: "revert", to: { n: 0, hash: "" } },
    { op: "branch.create", name: "Alt" },
  );
  expect(reasons(result)).toEqual([
    [0, "unsupported"],
    [1, "unsupported"],
  ]);
});
