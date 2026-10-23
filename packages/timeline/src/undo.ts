// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Undo (docs/architecture.md#undo-revert-and-going-back): the operations that take a batch back,
// worked out from three documents: just before the batch, just after it, and now. A change the
// batch made is taken back only where it still stands as the batch left it; one changed since is
// left alone and reported, so an undo never takes back someone else's later edit.

import type { Batch } from "./batch";
import { itemId, type ItemId } from "./ids";
import { leafOf, type Document } from "./project";

type Operation = Batch["ops"][number];

/** An operation of the batch that the undo leaves alone, by its index, and why. */
type Left = { index: number; reason: string };

/** The operations that take a batch back, last first, and what they leave alone. */
export type Undo = { ops: Operation[]; left: Left[] };

type Documents = { before: Document; after: Document; now: Document };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const keyframeAt = (document: Document, target: ItemId, param: string, at: number) =>
  document.keyframes(target).find((keyframe) => keyframe.param === param && keyframe.at === at);

// Whether a record is as the batch left it, and live or removed as wanted.
function stands(docs: Documents, id: string, removed: boolean) {
  const now = docs.now.record(id);
  return now !== undefined && now.removed === removed && same(now, docs.after.record(id));
}

// What takes back one operation, whose own id is `id`, or why it is left alone.
function undoOne(op: Operation, id: ItemId, docs: Documents): Operation[] | string {
  const { before, after, now } = docs;

  switch (op.op) {
    case "project.set":
      if (now.name() !== after.name()) return "renamed since";
      return [{ op: "project.set", name: before.name() }];
    case "asset.add":
      if (!stands(docs, op.asset.id, false)) return "changed since";
      return [{ op: "asset.remove", id: op.asset.id }];
    case "asset.remove": {
      const asset = before.asset(op.id);
      if (asset === undefined || !stands(docs, op.id, true)) return "changed since";
      return [{ op: "asset.add", asset }];
    }
    case "sequence.add":
      return stands(docs, id, false) ? [{ op: "sequence.remove", id }] : "changed since";
    case "role.add":
      return stands(docs, id, false) ? [{ op: "role.remove", id }] : "changed since";
    case "item.add":
      return stands(docs, id, false) ? [{ op: "item.remove", id }] : "changed since";
    case "effect.add":
      return stands(docs, id, false) ? [{ op: "effect.remove", id }] : "changed since";
    case "sequence.set":
    case "role.set":
    case "item.set":
    case "effect.set": {
      const was = before.record(op.id);
      // A record the batch added itself goes when its adding is undone.
      if (was === undefined) return [];
      const current = now.record(op.id);
      if (current === undefined || current.removed) return "removed since";
      const given = after.record(op.id);
      const value = leafOf(current.record, op.path);
      if (given === undefined || !same(value, leafOf(given.record, op.path)))
        return "changed since";
      const old = leafOf(was.record, op.path);
      if (old === undefined) return "had no value before";
      return [{ op: op.op, id: op.id, path: op.path, value: old }];
    }
    case "item.remove":
      return stands(docs, op.id, true) ? [{ op: "item.restore", id: op.id }] : "changed since";
    case "item.restore":
      return stands(docs, op.id, false) ? [{ op: "item.remove", id: op.id }] : "changed since";
    case "sequence.remove":
    case "role.remove":
    case "effect.remove":
      return "can't be restored";
    case "item.move": {
      const was = before.item(op.id);
      if (was === undefined) return [];
      if (was.kind === "transition") return "not placed by an anchor";
      return stands(docs, op.id, false)
        ? [{ op: "item.move", id: op.id, anchor: was.anchor }]
        : "changed since";
    }
    case "clip.split":
      if (!stands(docs, op.id, false) || !stands(docs, id, false)) return "changed since";
      return [{ op: "clip.join", id: op.id, next: id }];
    case "clip.join": {
      // Split again where the first piece ended, if the joined clip is as the join left it.
      const first = before.item(op.id);
      const start = now.start(op.id);
      if (first === undefined || start === undefined || !stands(docs, op.id, false))
        return "changed since";
      return [{ op: "clip.split", id: op.id, at: start + first.duration }];
    }
    case "keyframe.set": {
      const { target, param, at } = op.keyframe;
      const current = keyframeAt(now, target, param, at);
      if (!same(current, keyframeAt(after, target, param, at))) return "changed since";
      const old = keyframeAt(before, target, param, at);
      return [
        old === undefined
          ? { op: "keyframe.remove", target, param, at }
          : { op: "keyframe.set", keyframe: old },
      ];
    }
    case "keyframe.remove": {
      const old = keyframeAt(before, op.target, op.param, op.at);
      if (old === undefined || keyframeAt(now, op.target, op.param, op.at) !== undefined)
        return "changed since";
      return [{ op: "keyframe.set", keyframe: old }];
    }
    case "revert":
      return "taken back by reverting to a later entry";
    case "branch.create":
    case "branch.merge":
    case "branch.close":
      return "not undone";
    default: {
      const unknown: never = op;
      return unknown;
    }
  }
}

/**
 * The operations that undo `batch`, last operation first, from the documents just before and
 * just after it and the document now. `skipped` are the indexes of the operations it skipped.
 */
export function undoBatch(
  batch: Pick<Batch, "author" | "seq" | "ops">,
  skipped: ReadonlySet<number>,
  docs: Documents,
): Undo {
  const ops: Operation[] = [];
  const left: Left[] = [];

  for (const [index, op] of [...batch.ops.entries()].toReversed()) {
    if (skipped.has(index)) continue;
    const undo = undoOne(op, itemId(batch.author, batch.seq, index), docs);
    if (typeof undo === "string") left.push({ index, reason: undo });
    else ops.push(...undo);
  }

  return { ops, left };
}
