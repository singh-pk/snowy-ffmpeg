// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Batches (docs/architecture.md#batches): one gesture's operations, signed by their author. A
// batch's bytes are its canonical JSON (src/schema.ts), at most 1 MiB. A peer re-encodes every
// batch it reads and refuses one whose bytes differ, so every peer hashes and verifies the same
// bytes. The signature covers `snowy batch v1\n` and the canonical bytes without `sig`, so it
// can't pass for anything else a peer key signs.

import { branchId, entryRef, hash, keyId, operation } from "./document";
import type { KeyId } from "./ids";
import {
  either,
  InvalidError,
  array,
  integer,
  literal,
  optional,
  record,
  refine,
  string,
} from "./schema";

/** The largest batch, in canonical bytes. */
export const MAX_BATCH_BYTES = 1 << 20;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DOMAIN = encoder.encode("snowy batch v1\n");
// An Ed25519 signature: 64 bytes as unpadded base64url, in their one spelling.
const SIG = /^[A-Za-z0-9_-]{85}[AQgw]$/;

const fields = {
  author: keyId,
  seq: integer(1),
  prev: either([literal(""), hash], "not a hash"),
  branch: branchId,
  branchPrev: integer(0),
  base: entryRef,
  hlc: string(/^[0-9a-f]{16}$/),
  label: string(undefined, 256),
  undoes: optional(record({ author: keyId, seq: integer(1) })),
  ops: array(operation, 1),
};

// Rules between fields, which no one field's schema can see.
function chained(batch: { seq: number; prev: string; branchPrev: number }) {
  return (batch.seq === 1) === (batch.prev === "") && batch.branchPrev < batch.seq;
}

const unsignedBatch = refine(record(fields), chained, "prev or branchPrev doesn't fit seq");
const signedBatch = refine(
  record({ ...fields, sig: string(SIG) }),
  chained,
  "prev or branchPrev doesn't fit seq",
);

/** A signed batch, in canonical shape. */
export type Batch = ReturnType<typeof signedBatch>;
/** A batch before its author signs it. */
export type UnsignedBatch = ReturnType<typeof unsignedBatch>;

function bytesOf(value: unknown) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_BATCH_BYTES) throw new InvalidError("", "a batch over 1 MiB");
  return bytes;
}

/** Checks an untrusted batch, returning it in canonical shape. Throws an `InvalidError`. */
export const checkBatch = (value: unknown): Batch => signedBatch(value, "");

/** A batch's canonical bytes. Throws an `InvalidError` for a malformed or oversized batch. */
export const encodeBatch = (batch: Batch) => bytesOf(checkBatch(batch));

/** Reads a batch's bytes, refusing any that aren't its canonical bytes. Throws an `InvalidError`. */
export function decodeBatch(bytes: Uint8Array): Batch {
  if (bytes.byteLength > MAX_BATCH_BYTES) throw new InvalidError("", "a batch over 1 MiB");
  let parsed: unknown;

  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InvalidError("", "not UTF-8 JSON");
  }

  const batch = checkBatch(parsed);
  const canonical = bytesOf(batch);
  const same =
    canonical.byteLength === bytes.byteLength && canonical.every((b, i) => b === bytes[i]);
  if (!same) throw new InvalidError("", "not in canonical form");
  return batch;
}

const base64url = (bytes: ArrayBuffer) =>
  new Uint8Array(bytes).toBase64({ alphabet: "base64url", omitPadding: true });

// What the signature covers: the domain, then the canonical bytes without `sig`.
function signedBytes(batch: UnsignedBatch) {
  const body = bytesOf(unsignedBatch(batch, ""));
  const bytes = new Uint8Array(DOMAIN.byteLength + body.byteLength);
  bytes.set(DOMAIN);
  bytes.set(body, DOMAIN.byteLength);
  return bytes;
}

/** The id of a peer's public key, as `author` names it. */
export async function keyIdOf(publicKey: CryptoKey): Promise<KeyId> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return base64url(raw);
}

/** Signs a batch with its author's peer key. Throws if the key isn't the author's. */
export async function signBatch(peer: CryptoKeyPair, batch: UnsignedBatch): Promise<Batch> {
  const author = await keyIdOf(peer.publicKey);
  if (author !== batch.author) throw new RangeError("a batch is signed by its author");
  const sig = await crypto.subtle.sign("Ed25519", peer.privateKey, signedBytes(batch));
  const signed = checkBatch({ ...batch, sig: base64url(sig) });
  // The signature adds bytes, which can take a batch just under the limit over it.
  bytesOf(signed);
  return signed;
}

/** Whether a batch's signature is its author's. */
export async function verifyBatch(batch: Batch) {
  const { sig, ...unsigned } = batch;
  const raw = Uint8Array.fromBase64(batch.author, { alphabet: "base64url" });
  const publicKey = await crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
  const signature = Uint8Array.fromBase64(sig, { alphabet: "base64url" });
  return crypto.subtle.verify("Ed25519", publicKey, signature, signedBytes(unsigned));
}

/** The SHA-256 of a batch's canonical bytes, signature included, as unpadded base64url. */
export async function batchHash(batch: Batch) {
  const digest = await crypto.subtle.digest("SHA-256", encodeBatch(batch));
  return base64url(digest);
}
