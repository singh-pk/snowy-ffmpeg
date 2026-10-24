// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Branches (src/branches.ts), in Chromium: a branch starts from the document at its creating entry
// and is sequenced by its creator, a merge brings a branch's edits once each, what waits for a
// branch or for merged entries is applied when they arrive, and a closed branch takes no more.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import type { Batch } from "../src/batch";
import { createBranches } from "../src/branches";
import type { Entry } from "../src/entry";
import { author, fail, rename } from "./support/history";
import type { Op } from "./support/project";

// Two authors and their project, sequenced by `a`, where `b` has created the branch "Alt" in
// main's second entry. Every batch and entry made is kept, to hand another peer.
async function setUp() {
  const a = await author();
  const b = await author();
  const branches = createBranches({ sequencer: a.key });
  const batches: Array<{ batch: Batch; hash: string }> = [];
  const entries: Entry[] = [];
  let clock = 0;

  const historyOf = (branch: string) => branches.history(branch) ?? fail();

  // Commits a batch on `branch` and runs both sequencers, unless `pending`.
  async function edit(by: typeof a, branch: string, ops: Op[], pending = false) {
    clock += 1;
    const hlc = clock.toString(16).padStart(16, "0");
    const { batch, hash } = await by.commitTo(branch, ops, hlc, historyOf(branch).head());
    batches.push({ batch, hash });
    await branches.pend(batch, hash);
    if (pending) return { batch, entered: [] };
    const byA = await branches.sequence(a.peer);
    const byB = await branches.sequence(b.peer);
    entries.push(...byA.entries, ...byB.entries);
    const entered = [...byA.changes.values(), ...byB.changes.values()].flatMap(
      (change) => change.entered,
    );
    return { batch, entered };
  }

  await edit(a, "main", [rename("One")]);
  await edit(b, "main", [{ op: "branch.create", name: "Alt" }, rename("Two")]);
  const alt = `${b.key}.1.0`;
  return { a, b, branches, batches, entries, edit, historyOf, alt };
}

test("a branch starts from the document at its creating entry and is sequenced by its creator", async () => {
  const { a, b, branches, edit, historyOf, alt } = await setUp();
  const main = historyOf("main");
  expect(branches.branches()).toEqual([
    { id: "main", name: "main", sequencer: a.key, closed: false },
    {
      id: alt,
      name: "Alt",
      from: { branch: "main", entry: main.head() },
      sequencer: b.key,
      closed: false,
    },
  ]);
  // The whole creating batch is applied, the operations after the creation too.
  expect(historyOf(alt).document().name()).toBe("Two");

  await edit(b, alt, [rename("Three")], true);
  await branches.sequence(a.peer);
  expect(historyOf(alt).pending()).toHaveLength(1);
  const { entries } = await branches.sequence(b.peer);
  expect(entries.map(({ branch, n }) => [branch, n])).toEqual([[alt, 1]]);
  expect(historyOf(alt).document().name()).toBe("Three");
  expect(main.document().name()).toBe("Two");
});

test("a batch or entry for a branch not created here yet waits for it", async () => {
  const { a, b, batches, entries, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  const other = createBranches({ sequencer: a.key });
  const onAlt = batches.filter(({ batch }) => batch.branch === alt);
  const onMain = batches.filter(({ batch }) => batch.branch === "main");

  for (const { batch, hash } of onAlt) await other.pend(batch, hash);
  for (const entry of entries.filter(({ branch }) => branch === alt)) await other.append(entry);
  expect(other.history(alt)).toBe(undefined);

  for (const { batch, hash } of onMain) await other.pend(batch, hash);
  for (const entry of entries.filter(({ branch }) => branch === "main")) await other.append(entry);
  const copy = other.history(alt) ?? fail();
  expect(copy.entries()).toEqual(historyOf(alt).entries());
  expect(copy.document().snapshot()).toEqual(historyOf(alt).document().snapshot());
});

test("a merge brings a branch's edits to the target once each, with their own ids", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  const added = await edit(b, alt, [
    {
      op: "sequence.add",
      sequence: { name: "Alt cut", rate: [24, 1], width: 1920, height: 1080, sampleRate: 48_000 },
    },
  ]);
  await edit(b, alt, [rename("Alt")]);
  const through = historyOf(alt).head();
  const { entered } = await edit(a, "main", [{ op: "branch.merge", branch: alt, through }]);
  const main = historyOf("main").document();
  expect(main.name()).toBe("Alt");
  expect(main.sequence(`${b.key}.${added.batch.seq}.0`)?.name).toBe("Alt cut");
  expect(entered[0]?.merged.map(({ batch }) => batch.seq)).toEqual([2, 3]);

  // Merging again brings nothing, and merging main back brings only what the branch lacks.
  const again = await edit(a, "main", [{ op: "branch.merge", branch: alt, through }]);
  expect(again.entered[0]?.merged).toEqual([]);
  await edit(a, "main", [rename("Main")]);
  const back = await edit(b, alt, [
    { op: "branch.merge", branch: "main", through: historyOf("main").head() },
  ]);
  const brought = back.entered[0]?.merged.map(({ batch }) => [batch.author, batch.seq]);
  expect(brought).toEqual([
    [a.key, 2],
    [a.key, 3],
    [a.key, 4],
  ]);
  expect(historyOf(alt).document().name()).toBe("Main");
  // The merges among them aren't merged again: they name main's entries.
  expect(back.entered[0]?.merged[0]?.skipped.map(({ reason }) => reason)).toEqual(["unsupported"]);
});

test("a merge of chosen entries applies them in the branch's order, and a stale one is skipped", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  const first = historyOf(alt).head();
  await edit(b, alt, [rename("Four")]);
  const second = historyOf(alt).head();
  await edit(a, "main", [{ op: "branch.merge", branch: alt, entries: [second, first] }]);
  expect(historyOf("main").document().name()).toBe("Four");

  const { entered } = await edit(a, "main", [
    { op: "branch.merge", branch: alt, entries: [{ n: 1, hash: second.hash }] },
  ]);
  expect(entered[0]?.skipped.map(({ reason }) => reason)).toEqual(["stale"]);
});

test("an entry merging entries this peer doesn't have yet waits for them", async () => {
  const { a, b, batches, entries, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  await edit(a, "main", [{ op: "branch.merge", branch: alt, through: historyOf(alt).head() }]);
  const other = createBranches({ sequencer: a.key });

  for (const { batch, hash } of batches.filter((each) => each.batch.branch === "main"))
    await other.pend(batch, hash);
  for (const entry of entries.filter(({ branch }) => branch === "main")) await other.append(entry);
  const main = other.history("main") ?? fail();
  expect(main.head().n).toBe(2);

  for (const { batch, hash } of batches.filter((each) => each.batch.branch === alt))
    await other.pend(batch, hash);
  for (const entry of entries.filter(({ branch }) => branch === alt)) await other.append(entry);
  expect(main.head()).toEqual(historyOf("main").head());
  expect(main.document().snapshot()).toEqual(historyOf("main").document().snapshot());
});

test("a merge whose edits clash with a change on the target since the branch started is concurrent", async () => {
  const { a, b, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [rename("Three")]);
  const quiet = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  expect(quiet.entered[0]?.concurrent).toBe(false);

  await edit(b, alt, [rename("Four")]);
  const clashing = await edit(a, "main", [
    { op: "branch.merge", branch: alt, through: historyOf(alt).head() },
  ]);
  // The first merge's rename, on main since the branch started, clashes with the branch's.
  expect(clashing.entered[0]?.concurrent).toBe(true);
});

test("a closed branch takes no more entries, and main can't close", async () => {
  const { a, b, branches, edit, historyOf, alt } = await setUp();
  await edit(b, alt, [{ op: "branch.close", branch: alt }]);
  expect(branches.branches()[1]?.closed).toBe(true);
  await edit(b, alt, [rename("Late")]);
  expect(historyOf(alt).pending()).toHaveLength(1);
  expect(historyOf(alt).head().n).toBe(1);

  const { entered } = await edit(a, "main", [{ op: "branch.close", branch: "main" }]);
  expect(entered[0]?.skipped.map(({ reason }) => reason)).toEqual(["structural"]);
  expect(branches.branches()[0]?.closed).toBe(false);
});
