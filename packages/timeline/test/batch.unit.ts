// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Batches (src/batch.ts), in Chromium: a batch signs and verifies with its author's key, reads
// back exactly from its canonical bytes, and anything but those bytes, or a batch whose fields
// don't fit together, is refused.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import {
  batchHash,
  checkBatch,
  decodeBatch,
  encodeBatch,
  keyIdOf,
  MAX_BATCH_BYTES,
  signBatch,
  verifyBatch,
  type UnsignedBatch,
} from "../src/batch";
import { InvalidError } from "../src/schema";
import { rejection } from "./support/rejection";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const generate = () => crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);

async function unsigned(peer: CryptoKeyPair, changes: Partial<UnsignedBatch> = {}) {
  const author = await keyIdOf(peer.publicKey);
  const batch: UnsignedBatch = {
    author,
    seq: 1,
    prev: "",
    branch: "main",
    branchPrev: 0,
    base: { n: 0, hash: "" },
    hlc: "0000019a2b3c0000",
    label: "Insert",
    ops: [
      {
        op: "sequence.add",
        sequence: { name: "Main", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
      },
      {
        op: "item.add",
        item: {
          kind: "gap",
          anchor: { storyline: `${author}.1.0`, position: "a0" },
          duration: 29_400_000,
        },
      },
    ],
  };
  return { ...batch, ...changes };
}

// A rename whose name is `length` characters long.
const projectSet = (length: number) => ({ op: "project.set" as const, name: "n".repeat(length) });

async function signed(peer: CryptoKeyPair) {
  const batch = await unsigned(peer);
  return signBatch(peer, batch);
}

// The batch's JSON with `edit` applied to the parsed object, as bytes.
function edited(bytes: Uint8Array, edit: (json: Record<string, unknown>) => unknown) {
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  if (typeof parsed !== "object" || parsed === null) throw new TypeError("not an object");
  const json: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  return encoder.encode(JSON.stringify(edit(json) ?? json));
}

test("a batch signed by its author verifies, and reads back from its bytes unchanged", async () => {
  const peer = await generate();
  const batch = await signed(peer);
  const verified = await verifyBatch(batch);
  expect(verified).toBe(true);
  expect(decodeBatch(encodeBatch(batch))).toEqual(batch);
});

test("any change to a signed batch fails to verify", async () => {
  const peer = await generate();
  const batch = await signed(peer);
  const relabelled = await verifyBatch({ ...batch, label: "Delete" });
  const renumbered = await verifyBatch({ ...batch, seq: 2, prev: "A".repeat(43) });
  expect(relabelled).toBe(false);
  expect(renumbered).toBe(false);
});

test("a batch is signed only by its author's key", async () => {
  const [author, other] = await Promise.all([generate(), generate()]);
  const batch = await unsigned(author);
  const error = await rejection(signBatch(other, batch));
  expect(error).toBeInstanceOf(RangeError);
});

test("the hash covers the canonical bytes and is the same for the same batch", async () => {
  const peer = await generate();
  const batch = await signed(peer);
  const first = await batchHash(batch);
  const again = await batchHash(decodeBatch(encodeBatch(batch)));
  const other = await batchHash({ ...batch, label: "Other" });
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(again).toBe(first);
  expect(other === first).toBe(false);
});

test("bytes that parse to the same batch but aren't canonical are refused", async () => {
  const peer = await generate();
  const batch = await signed(peer);
  const bytes = encodeBatch(batch);
  const text = decoder.decode(bytes);
  const variants = [
    encoder.encode(` ${text}`),
    encoder.encode(JSON.stringify(JSON.parse(text), null, 1)),
    // Fields out of their declared order.
    edited(bytes, ({ seq, ...rest }) => ({ ...rest, seq })),
    // A duplicate key, which JSON.parse quietly takes the last of.
    encoder.encode(text.replace('"label":"Insert"', '"label":"X","label":"Insert"')),
    // 1.0 parses as 1, -0 as 0, and \u0041 as A.
    encoder.encode(text.replace('"width":1920', '"width":1920.0')),
    encoder.encode(text.replace('"branchPrev":0', '"branchPrev":-0')),
    encoder.encode(text.replace('"label":"Insert"', '"label":"\\u0049nsert"')),
  ];
  for (const variant of variants) expect(() => decodeBatch(variant)).toThrow(InvalidError);
});

test("unknown fields and unknown operations are refused", async () => {
  const peer = await generate();
  const batch = await signed(peer);
  const bytes = encodeBatch(batch);
  const variants = [
    edited(bytes, (json) => ({ ...json, extra: 1 })),
    edited(bytes, (json) => ({ ...json, ops: [{ op: "item.explode", id: "x" }] })),
    edited(bytes, (json) => ({ ...json, ops: [] })),
  ];
  for (const variant of variants) expect(() => decodeBatch(variant)).toThrow(InvalidError);
  expect(() => decodeBatch(new Uint8Array([0xff]))).toThrow(InvalidError);
});

test("prev and branchPrev must fit seq", async () => {
  const peer = await generate();
  const batch = await unsigned(peer);
  const base = { ...batch, sig: "A".repeat(86) };
  const hash = "A".repeat(43);
  expect(() => checkBatch({ ...base, prev: hash })).toThrow(InvalidError);
  expect(() => checkBatch({ ...base, seq: 2 })).toThrow(InvalidError);
  expect(() => checkBatch({ ...base, seq: 2, prev: hash, branchPrev: 2 })).toThrow(InvalidError);
  expect(checkBatch({ ...base, seq: 2, prev: hash, branchPrev: 1 }).seq).toBe(2);
});

test("a label with a lone surrogate reads back unchanged", async () => {
  const peer = await generate();
  const batch = await unsigned(peer, { label: "cut \uD800" });
  const signedBatch = await signBatch(peer, batch);
  expect(decodeBatch(encodeBatch(signedBatch))).toEqual(signedBatch);
});

test("values nested past the limit are refused as invalid, however deep", async () => {
  const peer = await generate();
  const batch = await signed(peer);
  const text = decoder.decode(encodeBatch(batch));
  const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
  const op = `{"op":"item.set","id":"${batch.author}.1.0","path":"x","value":${deep}}`;
  const bytes = encoder.encode(text.replace(/"ops":\[.*\],"sig"/, `"ops":[${op}],"sig"`));
  expect(() => decodeBatch(bytes)).toThrow(InvalidError);
});

test("a batch that signing takes over 1 MiB is refused when signed", async () => {
  const peer = await generate();
  const base = await unsigned(peer);
  const size = (ops: UnsignedBatch["ops"]) =>
    encoder.encode(JSON.stringify({ ...base, ops })).byteLength;
  // Enough operations to come within 20 bytes of the limit before the signature, the last with
  // a name of 6 to 140 characters, inside the 256 a name may have.
  const each = size([projectSet(100), projectSet(100)]) - size([projectSet(100)]);
  const count = Math.floor((MAX_BATCH_BYTES - 60 - size([projectSet(100)])) / each) + 1;
  const ops = Array.from({ length: count }, () => projectSet(100));
  ops.push(projectSet(MAX_BATCH_BYTES - 20 - size([...ops, projectSet(0)])));
  expect(ops.at(-1)?.name.length ?? 0).toBeLessThan(257);
  expect(size(ops)).toBe(MAX_BATCH_BYTES - 20);
  const error = await rejection(signBatch(peer, { ...base, ops }));
  expect(error).toBeInstanceOf(InvalidError);
});

test("a batch over 1 MiB is refused, made or read", async () => {
  const peer = await generate();
  const big = await unsigned(peer, { label: "x".repeat(256) });
  const op = { op: "project.set" as const, name: "n".repeat(256) };
  const ops = Array.from({ length: Math.ceil(MAX_BATCH_BYTES / 280) }, () => op);
  const error = await rejection(signBatch(peer, { ...big, ops }));
  expect(error).toBeInstanceOf(InvalidError);
  expect(() => decodeBatch(new Uint8Array(MAX_BATCH_BYTES + 1))).toThrow(InvalidError);
});
