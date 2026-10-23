// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Item ids (src/ids.ts), in Chromium: an id names its batch and operation, splits back into
// them, and has one spelling.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { isKeyId, itemId, parseItemId } from "../src/ids";

// A key id is 32 bytes in unpadded base64url: 43 characters, with `-` and `_` among them.
const AUTHOR = "Ab-_".repeat(10) + "xyw";

test("an id is the author, the batch's seq and the operation's index, and splits back", () => {
  const id = itemId(AUTHOR, 7, 0);
  expect(id).toBe(`${AUTHOR}.7.0`);
  expect(parseItemId(id)).toEqual({ author: AUTHOR, seq: 7, index: 0 });
});

test("a key id is 43 base64url characters, spelt the one way that decodes to its key", () => {
  expect(isKeyId(AUTHOR)).toBe(true);
  // The last character's two low bits are padding, so `x` (49) spells the same key as `w` (48).
  expect(isKeyId(`${AUTHOR.slice(0, -1)}x`)).toBe(false);
  expect(isKeyId(`${AUTHOR.slice(0, -1)}A`)).toBe(true);
  expect(isKeyId(AUTHOR.slice(1))).toBe(false);
  expect(isKeyId(`${AUTHOR}=`)).toBe(false);
  expect(isKeyId(`${AUTHOR.slice(1)}.`)).toBe(false);
  expect(isKeyId(`${AUTHOR.slice(1)}+`)).toBe(false);
});

test("an id can't be made from a bad author, seq or index", () => {
  expect(() => itemId("author", 1, 0)).toThrow(RangeError);
  expect(() => itemId(AUTHOR, 0, 0)).toThrow(RangeError);
  expect(() => itemId(AUTHOR, 1.5, 0)).toThrow(RangeError);
  expect(() => itemId(AUTHOR, 1, -1)).toThrow(RangeError);
  expect(() => itemId(AUTHOR, 2 ** 53, 0)).toThrow(RangeError);
});

test("anything but an id's one spelling doesn't parse", () => {
  const bad = [
    "",
    AUTHOR,
    `${AUTHOR}.1`,
    `${AUTHOR}.1.0.0`,
    `${AUTHOR}.0.0`,
    `${AUTHOR}.01.0`,
    `${AUTHOR}.1.00`,
    `${AUTHOR}.1.-1`,
    `${AUTHOR}.1.1e3`,
    `${AUTHOR}.99999999999999999.0`,
    `x${AUTHOR}.1.0`,
    `${AUTHOR.slice(0, -1)}x.1.0`,
  ];
  for (const id of bad) expect(parseItemId(id)).toBeUndefined();
});
