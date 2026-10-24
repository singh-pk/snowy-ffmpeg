// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The document's records and operations (src/document.ts) and the schemas under them
// (src/schema.ts), in Chromium: each operation reads back in canonical shape, open records sort
// their keys by code point, and values outside a record's rules are refused.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { anchor, entryRef, operation, value } from "../src/document";
import { InvalidError, map, record, string } from "../src/schema";

const AUTHOR = `${"Ab-_".repeat(10)}xyw`;
const SEQUENCE = `${AUTHOR}.1.0`;
const CLIP = `${AUTHOR}.1.1`;
const ASSET = "A".repeat(43);

const clip = {
  kind: "clip",
  source: { asset: ASSET, stream: 0 },
  in: 0,
  duration: 29_400_000,
  speed: [1, 1],
  anchor: { storyline: SEQUENCE, position: "a0" },
  role: `${AUTHOR}.1.2`,
  lane: 0,
  enabled: true,
  video: {
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  },
};

test("every kind of operation reads back unchanged", () => {
  const ops = [
    { op: "project.set", name: "Trailer" },
    { op: "item.add", item: clip },
    {
      op: "item.add",
      item: { kind: "gap", anchor: { storyline: SEQUENCE, position: "a1" }, duration: 1 },
    },
    {
      op: "item.add",
      item: { kind: "transition", cut: CLIP, duration: 10, effect: "cross.dissolve", params: {} },
    },
    {
      op: "item.add",
      item: {
        kind: "marker",
        anchor: { origin: SEQUENCE, at: 0 },
        duration: 0,
        type: "todo",
        name: "Fix",
        done: false,
      },
    },
    { op: "item.set", id: CLIP, path: "video.transform.x", value: 12.5 },
    { op: "item.move", id: CLIP, anchor: { clip: `${AUTHOR}.2.0`, at: -5 } },
    { op: "item.remove", id: CLIP },
    { op: "item.restore", id: CLIP },
    { op: "clip.split", id: CLIP, at: 100 },
    { op: "clip.join", id: CLIP, next: `${AUTHOR}.3.0` },
    {
      op: "effect.add",
      effect: {
        clip: CLIP,
        kind: "color.wheels",
        position: "a0",
        enabled: true,
        params: { lift: [0, 0, 0] },
      },
    },
    {
      op: "keyframe.set",
      keyframe: {
        target: CLIP,
        param: "video.opacity",
        at: 48,
        value: 0.5,
        ease: { bezier: [0.4, 0, 0.2, 1] },
      },
    },
    { op: "keyframe.remove", target: CLIP, param: "video.opacity", at: 48 },
    { op: "revert", to: { n: 212, hash: ASSET } },
    { op: "branch.create", name: "Alt ending" },
    { op: "branch.merge", branch: `${AUTHOR}.4.0`, through: { n: 3, hash: ASSET } },
    { op: "branch.merge", branch: `${AUTHOR}.4.0`, entries: [{ n: 2, hash: ASSET }] },
    { op: "branch.close", branch: `${AUTHOR}.4.0` },
  ];
  for (const op of ops) expect(operation(op, "")).toEqual(op);
});

test("a record comes back with its fields in declared order, whatever order they arrived in", () => {
  const shuffled = { duration: 1, anchor: { position: "a1", storyline: SEQUENCE }, kind: "gap" };
  const checked = operation({ item: shuffled, op: "item.add" }, "");
  expect(JSON.stringify(checked)).toBe(
    `{"op":"item.add","item":{"kind":"gap","anchor":{"storyline":"${SEQUENCE}","position":"a1"},"duration":1}}`,
  );
});

test("an open record's keys sort by code point, not by UTF-16 code unit", () => {
  // U+1F600 is a surrogate pair starting 0xD83D, which sorts before U+FF5E as code units.
  const schema = map(/^.+$/u, string());
  expect(Object.keys(schema({ "\u{1F600}": "", "～": "", a: "" }, ""))).toEqual([
    "a",
    "～",
    "\u{1F600}",
  ]);
});

test("values are booleans, finite numbers, strings and lists of them; -0 is 0", () => {
  expect(value([true, 1.5, "x", [2]], "")).toEqual([true, 1.5, "x", [2]]);
  expect(Object.is(value(-0, ""), 0)).toBe(true);

  for (const bad of [null, {}, Number.NaN, Number.POSITIVE_INFINITY, [undefined]]) {
    expect(() => value(bad, "")).toThrow(InvalidError);
  }
});

// 1, inside `depth` lists.
const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);

test("lists in a value nest at most 8 deep", () => {
  expect(value(nest(8), "")).toEqual(nest(8));
  expect(() => value(nest(9), "")).toThrow(InvalidError);
});

test("a path can name any parameter, digits included", () => {
  const op = { op: "effect.set", id: CLIP, path: "params.band1Gain", value: -3 };
  expect(operation(op, "")).toEqual(op);
});

test("an anchor is exactly one of its three shapes", () => {
  expect(anchor({ origin: SEQUENCE, at: 5 }, "")).toEqual({ origin: SEQUENCE, at: 5 });
  expect(() => anchor({ storyline: SEQUENCE, position: "a00" }, "")).toThrow(InvalidError);
  expect(() => anchor({ clip: CLIP, at: 0.5 }, "")).toThrow(InvalidError);
  expect(() => anchor({ clip: CLIP, origin: SEQUENCE, at: 0 }, "")).toThrow(InvalidError);
});

test("only entry 0 has no hash", () => {
  expect(entryRef({ n: 0, hash: "" }, "")).toEqual({ n: 0, hash: "" });
  expect(() => entryRef({ n: 0, hash: ASSET }, "")).toThrow(InvalidError);
  expect(() => entryRef({ n: 1, hash: "" }, "")).toThrow(InvalidError);
});

test("operations outside their records' rules are refused, with where", () => {
  const bad = [
    { op: "item.add", item: { ...clip, speed: [0, 1] } },
    { op: "item.add", item: { ...clip, lane: -1 } },
    { op: "item.add", item: { ...clip, id: CLIP } },
    { op: "item.add", item: { ...clip, kind: "slide" } },
    { op: "item.set", id: CLIP, path: "Video..x", value: 1 },
    { op: "item.set", id: "clip-1", path: "in", value: 1 },
    { op: "branch.merge", branch: "main" },
    {
      op: "keyframe.set",
      keyframe: { target: CLIP, param: "x", at: 0, value: 1, ease: { bezier: [0, 1] } },
    },
  ];
  for (const op of bad) expect(() => operation(op, "")).toThrow(InvalidError);
  expect(() => operation({ op: "item.add", item: { ...clip, lane: -1 } }, "ops[3]")).toThrow(
    "ops[3].item.lane",
  );
});

test("a record refuses fields it doesn't declare, and needs every field it does", () => {
  const schema = record({ a: string() });
  expect(() => schema({ a: "", b: "" }, "")).toThrow(InvalidError);
  expect(() => schema({}, "")).toThrow(InvalidError);
});
