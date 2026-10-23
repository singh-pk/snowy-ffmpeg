// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// One branch's linear history (docs/architecture.md#linear-history): the entries its sequencer
// appends, each naming a batch, and the batches still pending. The document every peer shows is
// the entries applied in order, then the pending batches in (hlc, author) order. The entries'
// document is kept apart from the shown one, so an entry that orders batches as they are shown
// changes nothing, and one that doesn't rebuilds the shown document from the entries' alone.

import { keyIdOf, type Batch } from "./batch";
import { entries as entryFormat, type Entry } from "./entry";
import type { ItemId, KeyId } from "./ids";
import { createProject, type Applied, type Range, type Snapshot } from "./project";

type Project = ReturnType<typeof createProject>;
type Operation = Batch["ops"][number];
type BranchId = Batch["branch"];

/** What a peer reads of a document: everything but applying. */
export type Document = Omit<Project, "apply">;

/** An entry as applied: the operations it skipped, and whether its author couldn't see a change. */
type Entered = { entry: Entry; skipped: Applied["skipped"]; concurrent: boolean };

/** What a call changed: the records and ranges to redraw, and the entries it applied. */
export type Change = {
  changed: ItemId[];
  ranges: Map<ItemId, Range>;
  entered: Entered[];
};

type Held = { batch: Batch; hash: string };

// The term every branch's first sequencer starts; later terms come with changing sequencer.
const FIRST_TERM = 1;

const keyOf = (ref: { author: KeyId; seq: number }) => `${ref.author} ${ref.seq}`;

// The provisional order of pending batches: by clock, then author, by code unit.
function byClock(a: Held, b: Held) {
  const ka = `${a.batch.hlc} ${a.batch.author}`;
  const kb = `${b.batch.hlc} ${b.batch.author}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// What an operation touches, for telling concurrent entries: an item as a whole, written `id`,
// or one leaf of it, written `id path`. Two leaves of one item don't clash; the whole item clashes
// with each of its leaves.
function touches(op: Operation): string[] {
  switch (op.op) {
    case "project.set":
      return ["project name"];
    case "asset.add":
      return [op.asset.id];
    case "sequence.set":
    case "role.set":
    case "item.set":
    case "effect.set":
      return [`${op.id} ${op.path}`];
    case "keyframe.set":
      return [`${op.keyframe.target} ${op.keyframe.param}@${op.keyframe.at}`];
    case "keyframe.remove":
      return [`${op.target} ${op.param}@${op.at}`];
    case "item.move":
    case "asset.remove":
    case "sequence.remove":
    case "role.remove":
    case "item.remove":
    case "item.restore":
    case "effect.remove":
      return [op.id];
    case "clip.split":
      return [op.id];
    case "clip.join":
      return [op.id, op.next];
    default:
      // What an operation adds has a new id no one else can have touched.
      return [];
  }
}

// Whether two sets of touches clash: the same leaf, or an item and anything of it.
function clash(mine: Set<string>, theirs: Set<string>) {
  for (const touch of theirs) {
    if (mine.has(touch)) return true;
    const [item = "", leaf] = touch.split(" ");
    if (leaf !== undefined && mine.has(item)) return true;
  }

  for (const touch of mine) {
    const [item = "", leaf] = touch.split(" ");
    if (leaf !== undefined && theirs.has(item)) return true;
  }

  return false;
}

function widen(ranges: Map<ItemId, Range>, more: Map<ItemId, Range>) {
  for (const [sequence, range] of more) {
    const was = ranges.get(sequence);
    const from = Math.min(was?.from ?? range.from, range.from);
    const to = Math.max(was?.to ?? range.to, range.to);
    ranges.set(sequence, { from, to });
  }
}

const emptyChange = (): Change => ({ changed: [], ranges: new Map(), entered: [] });

function record(change: Change, applied: Applied) {
  change.changed.push(...applied.changed);
  widen(change.ranges, applied.ranges);
}

/**
 * The history of `branch`, sequenced by `sequencer`, whose document starts from `from`, or empty.
 * Batches handed to it must already be verified: signed by their author and chained to the
 * author's previous batch.
 */
export function createHistory(options: { branch: BranchId; sequencer: KeyId; from?: Snapshot }) {
  const { branch, sequencer } = options;
  const appended: Entry[] = [];
  const hashes: string[] = [];
  // Each entry's author and touches, for telling later entries concurrent.
  const touched: Array<{ author: KeyId; touches: Set<string> }> = [];
  const held = new Map<string, Held>();
  const pending = new Map<string, Held>();
  // Entries that arrived before their batch or before the entry ahead of them, by n.
  const early = new Map<number, Entry>();
  // Batches the sequencer has received but not yet appended, as they arrived.
  const queue: string[] = [];
  // Batches appended to this branch, which the same author's next batch there can follow.
  const settled = new Set<string>();
  const entered = createProject(options.from);
  let view = createProject(entered.snapshot());
  // The pending batches as applied to the shown document, in order.
  let shown: Array<{ held: Held; applied: Applied }> = [];

  function head() {
    const n = appended.length;
    return { n, hash: n === 0 ? "" : (hashes[n - 1] ?? "") };
  }

  // Shows the pending batches again from the entries' document, in order, recording what both
  // the old and the new showing touched.
  function reshow(change: Change) {
    for (const { applied } of shown) record(change, applied);
    view = createProject(entered.snapshot());
    shown = [...pending.values()].toSorted(byClock).map((each) => {
      const applied = view.apply(each.batch);
      record(change, applied);
      return { held: each, applied };
    });
  }

  function concurrent(entry: Entry, batch: Batch, mine: Set<string>) {
    const from = Math.max(batch.base.n, 0);

    for (let n = from + 1; n < entry.n; n += 1) {
      const other = touched[n - 1];
      if (other !== undefined && other.author !== batch.author && clash(mine, other.touches))
        return true;
    }

    return false;
  }

  // Applies the next entry, whose batch is held, to the entries' document.
  function enter(entry: Entry, hash: string, change: Change) {
    const key = keyOf(entry.batch);
    const each = held.get(key);
    if (each === undefined) throw new RangeError(`no batch ${key}`);
    const applied = entered.apply(each.batch);
    const skipped = new Set(applied.skipped.map((skip) => skip.index));
    const mine = new Set(each.batch.ops.filter((_, i) => !skipped.has(i)).flatMap(touches));
    const isConcurrent = concurrent(entry, each.batch, mine);
    appended.push(entry);
    hashes.push(hash);
    touched.push({ author: each.batch.author, touches: mine });
    settled.add(key);
    pending.delete(key);
    change.entered.push({ entry, skipped: applied.skipped, concurrent: isConcurrent });

    // The entry orders its batch as the shown document had it first: nothing shown changes.
    if (shown[0]?.held === each) {
      shown.shift();
      return;
    }

    record(change, applied);
    reshow(change);
  }

  // Whether an entry can be the next: chained to the last, naming a batch not yet appended, with
  // the hash of the batch held under that name.
  function follows(entry: Entry) {
    const key = keyOf(entry.batch);
    const each = held.get(key);
    return (
      entry.n === appended.length + 1 &&
      entry.prev === head().hash &&
      !settled.has(key) &&
      (each === undefined || each.hash === entry.batch.hash)
    );
  }

  // Applies every early entry that is next and whose batch is held. One that turns out not to
  // follow is dropped; a valid entry with its number can still come.
  async function drain(change: Change) {
    for (let next = early.get(appended.length + 1); next !== undefined;) {
      if (!follows(next)) {
        early.delete(next.n);
        return;
      }

      if (!held.has(keyOf(next.batch))) return;
      early.delete(next.n);
      const hash = await entryFormat.hash(next);
      enter(next, hash, change);
      next = early.get(appended.length + 1);
    }
  }

  /** Takes a verified batch for this branch, showing it as pending until an entry appends it. */
  async function pend(batch: Batch, hash: string): Promise<Change> {
    if (batch.branch !== branch) throw new RangeError(`a batch for ${batch.branch}`);
    const key = keyOf(batch);
    const change = emptyChange();
    if (held.has(key)) return change;
    const each = { batch, hash };
    held.set(key, each);
    pending.set(key, each);
    queue.push(key);
    const last = shown.at(-1)?.held;

    if (last === undefined || byClock(last, each) < 0) {
      const applied = view.apply(batch);
      shown.push({ held: each, applied });
      record(change, applied);
    } else {
      reshow(change);
    }

    await drain(change);
    return change;
  }

  /**
   * Takes an entry from the sequencer. One for a batch not yet held, or ahead of the next entry,
   * waits until both are here. Throws a RangeError for an entry that isn't this branch's
   * sequencer's, or that is next and doesn't follow the last.
   */
  async function append(entry: Entry): Promise<Change> {
    if (entry.branch !== branch) throw new RangeError(`an entry of ${entry.branch}`);
    if (entry.term !== FIRST_TERM) throw new RangeError(`an entry of term ${entry.term}`);
    const valid = await entryFormat.verify(entry, sequencer);
    if (!valid) throw new RangeError("an entry not signed by the sequencer");
    const change = emptyChange();
    if (entry.n <= appended.length) return change;
    if (entry.n === appended.length + 1 && !follows(entry))
      throw new RangeError(`entry ${entry.n} doesn't follow`);
    early.set(entry.n, entry);
    await drain(change);
    return change;
  }

  // Whether a batch can be appended: its author's previous batch on the branch is.
  const ready = ({ batch }: Held) =>
    batch.branchPrev === 0 || settled.has(keyOf({ author: batch.author, seq: batch.branchPrev }));

  /**
   * As the sequencer, appends every received batch that can be: in (hlc, author) order, each once
   * its author's previous batch on the branch is appended. Returns the entries to publish.
   */
  async function sequence(peer: CryptoKeyPair) {
    const self = await keyIdOf(peer.publicKey);
    if (self !== sequencer) throw new RangeError("only the sequencer appends");
    const change = emptyChange();
    const made: Entry[] = [];
    const waiting = queue
      .splice(0)
      .flatMap((key) => {
        const each = held.get(key);
        return each === undefined || settled.has(key) ? [] : [each];
      })
      .toSorted(byClock);

    // Always the first ready batch in order, so one that appending unblocks keeps its place.
    for (let i = waiting.findIndex(ready); i !== -1; i = waiting.findIndex(ready)) {
      const [each] = waiting.splice(i, 1);
      if (each === undefined) break;
      const { author, seq } = each.batch;
      const ahead = head();
      const entry = await entryFormat.sign(peer.privateKey, {
        branch,
        n: ahead.n + 1,
        term: FIRST_TERM,
        prev: ahead.hash,
        batch: { author, seq, hash: each.hash },
      });
      const hash = await entryFormat.hash(entry);
      enter(entry, hash, change);
      made.push(entry);
    }

    queue.unshift(...waiting.map((each) => keyOf(each.batch)));
    return { entries: made, change };
  }

  return {
    pend,
    append,
    sequence,
    /** The last entry, as a batch's `base` names it. */
    head,
    /** The entries, 1 to n. */
    entries: (): readonly Entry[] => appended,
    /** The pending batches, in the order they are shown. */
    pending: () => shown.map(({ held: each }) => each.batch),
    /** The document as shown: the entries, then the pending batches. */
    document: (): Document => view,
  };
}
