// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Peers that sign batches, and histories of main, for tests of src/history.ts.

import { batchHash, keyIdOf, signBatch } from "../../src/batch";
import { createHistory } from "../../src/history";
import type { Op } from "./project";

export const generate = () => crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);

/** A peer that signs its batches in order, each on `main`. */
export async function author() {
  const peer = await generate();
  const key = await keyIdOf(peer.publicKey);
  const hashes: string[] = [];

  async function commit(
    ops: Op[],
    hlc: string,
    base = { n: 0, hash: "" },
    undoes?: { author: string; seq: number },
  ) {
    const seq = hashes.length + 1;
    const batch = await signBatch(peer, {
      author: key,
      seq,
      prev: hashes.at(-1) ?? "",
      branch: "main",
      branchPrev: seq - 1,
      base,
      hlc,
      label: "Edit",
      ...(undoes === undefined ? {} : { undoes }),
      ops,
    });
    const hash = await batchHash(batch);
    hashes.push(hash);
    return { batch, hash };
  }

  return { peer, key, commit };
}

/** A history of main sequenced by `sequencer`, and a helper that appends what it sequences. */
export function sequencedBy(sequencer: Awaited<ReturnType<typeof author>>) {
  const history = createHistory({ branch: "main", sequencer: sequencer.key });

  async function run() {
    const { entries: made } = await history.sequence(sequencer.peer);
    return made;
  }

  return { history, run };
}

export function fail(): never {
  throw new Error("missing");
}

export const rename = (name: string): Op => ({ op: "project.set", name });

export const sequenceAdd: Op = {
  op: "sequence.add",
  sequence: { name: "Main", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
};
