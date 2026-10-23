// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Undo, redo, revert and going back (src/undo.ts, src/history.ts), in Chromium: an undo takes
// back what still stands as the batch left it and reports the rest, redo is an undo of the undo,
// a revert sets the document back to an entry, and any entry can be looked at.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Batch } from "../src/batch";
import { createHistory, SNAPSHOT_EVERY } from "../src/history";
import { leafOf } from "../src/project";
import { author, fail, rename, sequenceAdd, sequencedBy } from "./support/history";
import type { Op } from "./support/project";

const SECOND = 705_600_000;

// Adds a connected video clip of `role`, two seconds long, anchored to `clip`.
const connected = (role: string, clip: string, at: number): Op => ({
  op: "item.add",
  item: {
    kind: "clip",
    source: { generator: "solid", params: { color: "#ffffff" } },
    in: 0,
    duration: 2 * SECOND,
    speed: [1, 1],
    anchor: { clip, at },
    role,
    lane: 1,
    enabled: true,
  },
});

const refOf = ({ author: by, seq }: { author: string; seq: number }) => ({ author: by, seq });

// A history sequenced by `a`, with a sequence, a video role and two generator clips in its
// storyline, and a helper that commits a batch by any author and appends it at once.
async function setUp() {
  const a = await author();
  const b = await author();
  const { history } = sequencedBy(a);
  const sequence = `${a.key}.1.0`;
  const role = `${a.key}.1.1`;
  let clock = 0;
  // Every batch committed, to hand another peer.
  const batches: Array<{ batch: Batch; hash: string }> = [];

  const clip = (position: string, duration = 2 * SECOND): Op => ({
    op: "item.add",
    item: {
      kind: "clip",
      source: { generator: "solid", params: { color: "#000000" } },
      in: 0,
      duration,
      speed: [1, 1],
      anchor: { storyline: sequence, position },
      role,
      lane: 0,
      enabled: true,
    },
  });

  // Commits a batch, which is appended unless `pending`.
  async function edit(
    by: typeof a,
    ops: Op[],
    options: { pending?: boolean; undoes?: { author: string; seq: number } } = {},
  ) {
    clock += 1;
    const hlc = clock.toString(16).padStart(16, "0");
    const { batch, hash } = await by.commit(ops, hlc, history.head(), options.undoes);
    batches.push({ batch, hash });
    await history.pend(batch, hash);
    const made = { author: batch.author, seq: batch.seq };
    if (options.pending === true) return { ...made, skipped: [] };
    const { change } = await history.sequence(a.peer);
    return { ...made, skipped: change.entered.at(-1)?.skipped ?? [] };
  }

  // Undoes a batch, committing its undo as `by`.
  async function undo(by: typeof a, target: { author: string; seq: number }, pending = false) {
    const { ops, left } = history.undo(refOf(target));
    if (ops.length === 0) return { ops, left, made: undefined };
    const made = await edit(by, ops, { pending, undoes: refOf(target) });
    return { ops, left, made: refOf(made) };
  }

  const roleAdd: Op = {
    op: "role.add",
    role: { sequence, name: "Video", kind: "video", color: "#3366ff", order: "a0" },
  };
  await edit(a, [sequenceAdd, roleAdd, clip("a0"), clip("a1")]);
  const first = `${a.key}.1.2`;
  const second = `${a.key}.1.3`;

  // An entry as an `EntryRef` names it: its hash is the next entry's prev, or the head's.
  function entryRef(n: number) {
    return n === history.head().n ? history.head() : { n, hash: history.entries()[n]?.prev ?? "" };
  }

  return { a, b, history, edit, undo, clip, sequence, role, first, second, batches, entryRef };
}

test("an undo sets a leaf back unless someone changed it since, and leaves other leaves alone", async () => {
  const { a, b, history, edit, undo, first } = await setUp();
  const trim = await edit(a, [
    { op: "item.set", id: first, path: "duration", value: SECOND },
    { op: "item.set", id: first, path: "video.opacity", value: 0.5 },
  ]);
  await edit(b, [{ op: "item.set", id: first, path: "video.opacity", value: 0.25 }]);
  await edit(b, [{ op: "item.set", id: first, path: "name", value: "B" }]);

  const { ops, left } = await undo(a, trim);
  expect(ops).toEqual([{ op: "item.set", id: first, path: "duration", value: 2 * SECOND }]);
  expect(left).toEqual([{ index: 1, reason: "changed since" }]);
  const clip = history.document().record(first)?.record ?? {};
  expect(leafOf(clip, "duration")).toBe(2 * SECOND);
  expect(leafOf(clip, "video.opacity")).toBe(0.25);
  expect(leafOf(clip, "name")).toBe("B");
});

test("an undo removes what the batch added and restores what it removed, unless changed since", async () => {
  const { a, b, history, edit, undo, clip, first, second } = await setUp();
  const added = await edit(a, [clip("a2"), clip("a3")]);
  const [third, fourth] = [`${a.key}.${added.seq}.0`, `${a.key}.${added.seq}.1`];
  await edit(b, [{ op: "item.set", id: fourth, path: "enabled", value: false }]);
  const { ops, left } = await undo(a, added);
  expect(ops).toEqual([{ op: "item.remove", id: third }]);
  expect(left).toEqual([{ index: 1, reason: "changed since" }]);
  expect(history.document().item(third)?.removed).toBe(true);
  expect(history.document().item(fourth)?.removed).toBe(false);

  const removed = await edit(a, [
    { op: "item.remove", id: first },
    { op: "item.remove", id: second },
  ]);
  await edit(b, [{ op: "item.restore", id: second }]);
  const undone = await undo(a, removed);
  expect(undone.ops).toEqual([{ op: "item.restore", id: first }]);
  expect(undone.left).toEqual([{ index: 1, reason: "changed since" }]);
  expect(history.document().item(first)?.removed).toBe(false);
});

test("an undo joins what a split made, splits what a join made, and sets keyframes back", async () => {
  const { a, history, edit, undo, first, sequence } = await setUp();
  const keyframe = (value: number) => ({
    op: "keyframe.set" as const,
    keyframe: { target: first, param: "video.opacity", at: 0, value, ease: "linear" as const },
  });
  await edit(a, [keyframe(1)]);
  const split = await edit(a, [{ op: "clip.split", id: first, at: SECOND }, keyframe(0.5)]);
  const piece = `${a.key}.${split.seq}.0`;
  expect(history.document().storyline(sequence).length).toBe(3);

  const { ops } = await undo(a, split);
  expect(ops).toEqual([keyframe(1), { op: "clip.join", id: first, next: piece }]);
  expect(history.document().storyline(sequence).length).toBe(2);
  expect(history.document().keyframes(first)[0]?.value).toBe(1);

  const joined = await edit(a, [{ op: "clip.split", id: first, at: SECOND }]);
  const again = `${a.key}.${joined.seq}.0`;
  const join = await edit(a, [{ op: "clip.join", id: first, next: again }]);
  const undoJoin = await undo(a, join);
  expect(undoJoin.ops).toEqual([{ op: "clip.split", id: first, at: SECOND }]);
  expect(history.document().item(first)?.duration).toBe(SECOND);
});

test("undo takes back the author's latest edit not undone, redo the latest undo, and a new edit ends redo", async () => {
  const { a, b, history, edit, undo, first } = await setUp();
  const editOne = await edit(a, [rename("one")]);
  const editTwo = await edit(a, [rename("two")], { pending: true });
  const [one, two] = [refOf(editOne), refOf(editTwo)];
  await edit(b, [{ op: "item.set", id: first, path: "name", value: "b" }], { pending: true });
  expect(history.undoable(a.key)).toEqual(two);
  expect(history.redoable(a.key)).toBeUndefined();

  // Undoing works on a pending batch as on an appended one.
  const undid = await undo(a, two, true);
  expect(undid.ops).toEqual([{ op: "project.set", name: "one" }]);
  expect(history.document().name()).toBe("one");
  expect(history.undoable(a.key)).toEqual(one);

  const redoUndo = await undo(a, one);
  expect(redoUndo.ops).toEqual([{ op: "project.set", name: "" }]);
  const undoOne = redoUndo.made ?? fail();
  // What undo takes back next is the batch that set the project up.
  expect(history.undoable(a.key)).toEqual({ author: a.key, seq: 1 });
  expect(history.redoable(a.key)).toEqual(undoOne);

  const redo = await undo(a, undoOne);
  expect(redo.ops).toEqual([{ op: "project.set", name: "one" }]);
  // The undo of two is still live, so redo brings two back next.
  expect(history.redoable(a.key)).toEqual(undid.made);
  expect(history.undoable(a.key)).toEqual(one);

  const undoneAgain = await undo(a, one);
  expect(history.redoable(a.key)).toEqual(undoneAgain.made);
  await edit(a, [rename("three")]);
  expect(history.redoable(a.key)).toBeUndefined();
});

test("a revert sets the document back to an entry, keeping what came after as removed", async () => {
  const { a, b, history, edit, undo, clip, first, sequence } = await setUp();
  const start = history.head();
  const added = await edit(a, [clip("a2"), rename("later")]);
  const third = `${a.key}.${added.seq}.0`;
  await edit(b, [{ op: "item.set", id: first, path: "duration", value: SECOND }]);

  const stale = await edit(b, [{ op: "revert", to: { n: start.n, hash: "Q".repeat(43) } }]);
  expect(stale.skipped.map(({ reason }) => reason)).toEqual(["stale"]);
  expect(history.document().name()).toBe("later");

  const reverted = await edit(b, [{ op: "revert", to: start }]);
  expect(reverted.skipped).toEqual([]);
  const document = history.document();
  expect(document.name()).toBe("");
  expect(document.item(first)?.duration).toBe(2 * SECOND);
  expect(document.item(third)?.removed).toBe(true);
  expect(document.storyline(sequence).map(({ id }) => id)).toEqual(
    history
      .at(start)
      .storyline(sequence)
      .map(({ id }) => id),
  );

  // A later restore brings back what the revert removed, with its state.
  await edit(a, [{ op: "item.restore", id: third }]);
  expect(history.document().item(third)?.removed).toBe(false);
  const undone = await undo(b, refOf(reverted));
  expect(undone.left).toEqual([{ index: 0, reason: "taken back by reverting to a later entry" }]);
});

test("going back shows the document at any entry, through the snapshots", async () => {
  const { a, history, edit } = await setUp();
  for (let i = 1; i <= SNAPSHOT_EVERY + 2; i += 1) await edit(a, [rename(`n${i}`)]);
  // Entry n's hash is the next entry's prev.
  const at = (n: number) => history.at({ n, hash: history.entries()[n]?.prev ?? "" });

  expect(history.head().n).toBe(SNAPSHOT_EVERY + 3);
  expect(at(0).name()).toBe("");
  expect(at(1).name()).toBe("");
  expect(at(2).name()).toBe("n1");
  expect(at(SNAPSHOT_EVERY + 1).name()).toBe(`n${SNAPSHOT_EVERY}`);
  expect(at(SNAPSHOT_EVERY + 2).name()).toBe(`n${SNAPSHOT_EVERY + 1}`);
  expect(() => history.at({ n: 2, hash: "Q".repeat(43) })).toThrow(RangeError);
  expect(() => history.at({ n: SNAPSHOT_EVERY + 4, hash: "Q".repeat(43) })).toThrow(RangeError);
});

test("an undo restores what the batch removed before setting back what it set on it", async () => {
  const { a, history, edit, undo, first } = await setUp();
  const batch = await edit(a, [
    { op: "item.set", id: first, path: "video.opacity", value: 0.5 },
    { op: "item.move", id: first, anchor: { storyline: `${a.key}.1.0`, position: "a5" } },
    { op: "item.remove", id: first },
  ]);
  const { ops, left } = await undo(a, refOf(batch));
  expect(left).toEqual([]);
  expect(ops).toEqual([
    { op: "item.restore", id: first },
    { op: "item.move", id: first, anchor: { storyline: `${a.key}.1.0`, position: "a0" } },
    { op: "item.set", id: first, path: "video.opacity", value: 1 },
  ]);
  const clip = history.document().record(first);
  expect(clip?.removed).toBe(false);
  expect(leafOf(clip?.record ?? {}, "video.opacity")).toBe(1);
});

test("a keyframe set and removed by one batch leaves nothing to undo", async () => {
  const { a, edit, undo, first } = await setUp();
  const keyframe = {
    target: first,
    param: "video.opacity",
    at: 0,
    value: 0.5,
    ease: "linear" as const,
  };
  const batch = await edit(a, [
    { op: "keyframe.set", keyframe },
    { op: "keyframe.remove", target: first, param: "video.opacity", at: 0 },
    rename("x"),
  ]);
  const { ops, left } = await undo(a, refOf(batch));
  expect(ops).toEqual([{ op: "project.set", name: "" }]);
  expect(left).toEqual([]);
});

test("undo passes over a batch that only reverts", async () => {
  const { a, history, edit } = await setUp();
  const named = await edit(a, [rename("x")]);
  await edit(a, [{ op: "revert", to: history.head() }]);
  expect(history.undoable(a.key)).toEqual(refOf(named));
});

test("a revert part way through a batch reverts to the entry before it, pending or appended", async () => {
  const { a, history, edit, batches, sequence, entryRef } = await setUp();
  await edit(a, [rename("x")]);
  const before = history.head();
  await edit(a, [rename("z"), { op: "revert", to: before }], { pending: true });
  expect(history.document().name()).toBe("x");
  await history.sequence(a.peer);
  expect(history.document().name()).toBe("x");
  expect(history.at(entryRef(history.head().n - 1)).name()).toBe("x");

  // Another peer, given only the batches and entries, reaches the same document.
  const other = createHistory({ branch: "main", sequencer: a.key });
  for (const { batch, hash } of batches) await other.pend(batch, hash);
  for (const entry of history.entries()) await other.append(entry);
  expect(other.document().snapshot()).toEqual(history.document().snapshot());
  expect(other.document().storyline(sequence)).toEqual(history.document().storyline(sequence));
});

test("reverts within reverts replay once, and keep the layout's indexes", async () => {
  const { a, history, edit, clip, sequence, role, first, entryRef } = await setUp();
  await edit(a, [connected(role, first, SECOND / 2)]);
  const connectedId = `${a.key}.2.0`;
  const placed = history.head();
  const startThen = history.document().start(connectedId);
  const lanesThen = history.document().lanes(role);
  await edit(a, [{ op: "item.move", id: connectedId, anchor: { origin: sequence, at: 0 } }]);
  await edit(a, [clip("a2")]);

  // Each revert goes back to the entry before the last, which holds the revert before it.
  for (let i = 0; i < 40; i += 1) {
    await edit(a, [rename(`r${i}`)]);
    await edit(a, [{ op: "revert", to: entryRef(history.head().n - 1) }]);
  }

  await edit(a, [{ op: "revert", to: placed }]);
  expect(history.document().start(connectedId)).toBe(startThen);
  expect(history.document().lanes(role)).toEqual(lanesThen);
  expect(history.at(entryRef(history.head().n - 2)).name()).toBe("r39");
});

test("an undo takes back a batch that changed one record twice", async () => {
  const { a, history, edit, undo, first, sequence } = await setUp();
  const opacity = { op: "item.set" as const, id: first, path: "video.opacity", value: 0.5 };
  const adjusted = await edit(a, [{ op: "clip.split", id: first, at: SECOND }, opacity]);
  const adjustUndo = await undo(a, refOf(adjusted));
  expect(adjustUndo.left).toEqual([]);
  expect(history.document().storyline(sequence).length).toBe(2);

  const piece = `${a.key}.${adjusted.seq}.0`;
  const restored = await edit(a, [
    { op: "item.restore", id: piece },
    { ...opacity, id: piece, value: 0.25 },
  ]);
  const restoreUndo = await undo(a, refOf(restored));
  expect(restoreUndo.left).toEqual([]);
  expect(history.document().item(piece)?.removed).toBe(true);

  const cut = await edit(a, [
    { op: "clip.split", id: first, at: SECOND / 2 },
    { op: "clip.split", id: `${a.key}.${history.head().n + 1}.0`, at: SECOND },
  ]);
  expect(cut.skipped).toEqual([]);
  expect(history.document().storyline(sequence).length).toBe(4);
  const cutUndo = await undo(a, refOf(cut));
  expect(cutUndo.left).toEqual([]);
  expect(history.document().storyline(sequence).length).toBe(2);
});
