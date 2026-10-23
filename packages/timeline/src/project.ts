// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// A project's document, changed only by applying batches (docs/architecture.md#applying). Every
// operation is checked again as it is applied, against the document as it is then, and one that
// doesn't fit is skipped and recorded, never half applied: a batch from a buggy or hostile peer
// can't break anyone's document, and every peer skips the same operations. Applying uses only
// the batch and the document: no clock, no random numbers, no locale.

import type { Batch } from "./batch";
import {
  item as itemSchema,
  role as roleSchema,
  sequence as sequenceSchema,
  type Anchor,
  type Asset,
  type ItemRecord,
  type RoleRecord,
  type SequenceRecord,
  type Value,
} from "./document";
import { itemId, type ItemId } from "./ids";
import { assignLanes, clipAnchorStart, originAnchorStart } from "./layout";
import { InvalidError } from "./schema";
import { createStoryline } from "./storyline";
import { FLICKS_PER_SECOND, frameFlicks, type Ratio } from "./time";

type Operation = Batch["ops"][number];

/** Why an operation was skipped: the kinds docs/architecture.md#applying names. */
type SkipReason = "malformed" | "stale" | "structural" | "unsupported";

/** An operation of a batch that applying skipped, by its index in the batch. */
type Skip = { index: number; reason: SkipReason; detail: string };

/** A time range of a sequence that changed, in flicks; infinite at an end that reaches all the way. */
export type Range = { from: number; to: number };

/** What applying a batch did. */
export type Applied = {
  skipped: Skip[];
  /** The ids of the records the batch changed, in the order it first changed them. */
  changed: ItemId[];
  /** Per sequence, the time range to redraw. */
  ranges: Map<ItemId, Range>;
};

// Thrown while applying one operation, to skip it.
class Skipped extends Error {
  constructor(
    readonly reason: SkipReason,
    detail: string,
  ) {
    super(detail);
    this.name = "Skipped";
  }
}

function skip(reason: SkipReason, detail: string): never {
  throw new Skipped(reason, detail);
}

type SequenceState = {
  record: SequenceRecord;
  removed: boolean;
  storyline: ReturnType<typeof createStoryline>;
};

type RoleState = { record: RoleRecord; removed: boolean };
type ItemState = { record: ItemRecord; sequence: ItemId; removed: boolean };
type AssetState = { record: Asset; removed: boolean };

// What a clip's absent video or audio fields are, so setting one leaf of them fills the rest.
const DEFAULTS: Record<string, Value | Record<string, unknown>> = {
  video: {
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  },
  audio: { gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 },
};

// The first segment of each path `*.set` may change; the rest are structural, changed by their
// own operations or never.
const SETTABLE: Record<string, ReadonlySet<string>> = {
  sequence: new Set(["name", "rate", "width", "height", "sampleRate"]),
  role: new Set(["name", "color", "order"]),
  clip: new Set(["in", "duration", "speed", "role", "lane", "enabled", "name", "video", "audio"]),
  gap: new Set(["duration"]),
  transition: new Set(["duration", "effect", "params"]),
  marker: new Set(["duration", "type", "name", "note", "done"]),
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `record` with the leaf at `path` set to `value`, as a new object to check against its schema.
 * A clip's generator parameters are reached as `source.params.<name>`.
 */
function withLeaf(record: object, kind: string, path: string, value: Value) {
  const segments = path.split(".");
  const [root = ""] = segments;
  const generatorParam =
    kind === "clip" && segments.length === 3 && path.startsWith("source.params.");
  if (!SETTABLE[kind]?.has(root) && !generatorParam) skip("malformed", `${path} can't be set`);
  const copy: Record<string, unknown> = structuredClone({ ...record });
  let node = copy;

  for (const [i, segment] of segments.slice(0, -1).entries()) {
    const next = node[segment] ?? (i === 0 ? structuredClone(DEFAULTS[segment]) : undefined);
    if (!isObject(next)) skip("malformed", `${path} isn't a field`);
    node[segment] = next;
    node = next;
  }

  node[segments.at(-1) ?? ""] = value;
  return copy;
}

// `check(value)`, or a skip for a value that doesn't fit.
function checked<T>(check: (value: unknown, at: string) => T, value: unknown) {
  try {
    return check(value, "");
  } catch (error) {
    if (error instanceof InvalidError) skip("malformed", error.message);
    throw error;
  }
}

function checkRate(rate: Ratio) {
  try {
    frameFlicks(rate);
  } catch {
    skip("malformed", `a frame at ${rate[0]}/${rate[1]} fps is not whole flicks`);
  }
}

// The item an operation is about, whose extent before and after it changed.
function subject(op: Operation, id: ItemId) {
  if (op.op === "item.add") return id;
  if (op.op.startsWith("item.") && "id" in op) return op.id;
  return undefined;
}

const inStoryline = (record: ItemRecord) =>
  record.kind !== "transition" && "storyline" in record.anchor;

// `change()`, skipped as malformed when it would take a time past the safe integers: storyline
// and layout refuse those with a RangeError, before changing anything.
function guarded<T>(change: () => T) {
  try {
    return change();
  } catch (error) {
    if (error instanceof RangeError) skip("malformed", error.message);
    throw error;
  }
}

// The time layout gives, or undefined for one past the safe integers, which isn't shown.
function shown(layout: () => number) {
  try {
    return layout();
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

// The record an item depends on to be placed: a connected item's clip, a transition's cut.
function dependsOn(record: ItemRecord) {
  if (record.kind === "transition") return record.cut;
  return "clip" in record.anchor ? record.anchor.clip : undefined;
}

// The records a clip uses: its role, and its asset or the sequence it plays.
function usedBy(record: ItemRecord) {
  if (record.kind !== "clip") return [];
  const { source } = record;
  if ("asset" in source) return [record.role, source.asset];
  return "sequence" in source ? [record.role, source.sequence] : [record.role];
}

function add(index: Map<string, Set<ItemId>>, key: string, id: ItemId) {
  const set = index.get(key) ?? new Set();
  set.add(id);
  index.set(key, set);
}

const EVERYTHING = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };

/** An empty project. */
export function createProject() {
  let name = "";
  const assets = new Map<string, AssetState>();
  const sequences = new Map<ItemId, SequenceState>();
  const roles = new Map<ItemId, RoleState>();
  const items = new Map<ItemId, ItemState>();
  // Indexes kept as items change, removed items included, so checks don't scan every item: the
  // items in each sequence, the items placed by each storyline item, and the clips using each
  // role, asset or played sequence.
  const members = new Map<ItemId, Set<ItemId>>();
  const dependents = new Map<string, Set<ItemId>>();
  const users = new Map<string, Set<ItemId>>();

  function live(index: Map<string, Set<ItemId>>, key: string) {
    return [...(index.get(key) ?? [])].filter((id) => items.get(id)?.removed === false);
  }

  function link(id: ItemId, record: ItemRecord) {
    const target = dependsOn(record);
    if (target !== undefined) add(dependents, target, id);
    for (const used of usedBy(record)) add(users, used, id);
  }

  function unlink(id: ItemId, record: ItemRecord) {
    const target = dependsOn(record);
    if (target !== undefined) dependents.get(target)?.delete(id);
    for (const used of usedBy(record)) users.get(used)?.delete(id);
  }

  function liveSequence(id: ItemId) {
    const state = sequences.get(id);
    if (state === undefined || state.removed) skip("stale", `no sequence ${id}`);
    return state;
  }

  function liveItem(id: ItemId) {
    const state = items.get(id);
    if (state === undefined || state.removed) skip("stale", `no item ${id}`);
    return state;
  }

  function liveRole(id: ItemId) {
    const state = roles.get(id);
    if (state === undefined || state.removed) skip("stale", `no role ${id}`);
    return state;
  }

  function storylineOf(id: ItemId) {
    const state = sequences.get(id);
    if (state === undefined) throw new RangeError(`no sequence ${id}`);
    return state.storyline;
  }

  // Whether sequence `outer` holds a compound clip of `inner`, directly or further down.
  function contains(outer: ItemId, inner: ItemId, seen = new Set<ItemId>()): boolean {
    if (seen.has(outer)) return false;
    seen.add(outer);

    for (const id of live(members, outer)) {
      const record = items.get(id)?.record;
      if (record?.kind !== "clip" || !("sequence" in record.source)) continue;
      const played = record.source.sequence;
      if (played === inner || contains(played, inner, seen)) return true;
    }

    return false;
  }

  /**
   * The sequence an item in `record` belongs to, if its anchor fits: storyline clips and gaps,
   * connected clips and markers on a storyline clip or the origin, and transitions on a
   * storyline item's end. A restored item may stay on a removed clip, as an orphan.
   */
  function sequenceFor(id: ItemId, record: ItemRecord, orphanOk: boolean) {
    if (record.kind === "transition") {
      const cut = liveItem(record.cut);
      if (!inStoryline(cut.record)) skip("structural", "a transition's cut is a storyline item");
      return cut.sequence;
    }

    const { anchor } = record;

    if ("storyline" in anchor) {
      if (record.kind === "marker") skip("structural", "a marker is connected, not in a storyline");
      liveSequence(anchor.storyline);
      return anchor.storyline;
    }

    if (record.kind === "gap") skip("structural", "a gap is in a storyline");

    if ("origin" in anchor) {
      liveSequence(anchor.origin);
      return anchor.origin;
    }

    const target = items.get(anchor.clip);

    if (target === undefined || (target.removed && !orphanOk)) {
      skip("stale", `no item ${anchor.clip}`);
    }

    if (anchor.clip === id || target.record.kind !== "clip" || !inStoryline(target.record)) {
      skip("structural", "connected items anchor to storyline clips");
    }

    return target.sequence;
  }

  // What a clip needs besides its anchor: a role of its sequence that takes its kind of media,
  // its asset and stream, and for a new compound clip, a sequence that doesn't hold this one (a
  // clip's source never changes, so that is checked only when it is added or restored).
  function checkClip(record: ItemRecord, sequence: ItemId, placing: boolean) {
    if (record.kind !== "clip") return;
    const role = liveRole(record.role);
    if (role.record.sequence !== sequence) skip("structural", "a clip's role is of its sequence");
    const { source } = record;
    let kind: "video" | "audio" | undefined;

    if ("asset" in source) {
      const asset = assets.get(source.asset);
      if (asset === undefined || asset.removed) skip("stale", `no asset ${source.asset}`);
      const stream = asset.record.streams.find((s) => s.index === source.stream);
      if (stream === undefined) skip("stale", `no stream ${source.stream} in ${source.asset}`);
      kind = stream.kind === "audio" ? "audio" : "video";
    } else if ("generator" in source) kind = "video";
    else if (placing) {
      liveSequence(source.sequence);

      if (source.sequence === sequence || contains(source.sequence, sequence)) {
        skip("structural", "a compound clip would contain itself");
      }
    }

    if (kind !== undefined && kind !== role.record.kind) {
      skip("structural", `a ${kind} clip in a ${role.record.kind} role`);
    }
  }

  // The time base a clip's source points are in.
  function timeBaseOf(record: ItemRecord): Ratio {
    if (record.kind !== "clip" || !("asset" in record.source)) return [1, FLICKS_PER_SECOND];
    const { asset: id, stream } = record.source;
    const found = assets.get(id)?.record.streams.find((s) => s.index === stream);
    return found?.timeBase ?? [1, FLICKS_PER_SECOND];
  }

  // A sequence's rate when `record` is video, which snaps to frames, or undefined for audio.
  function snapRate(record: ItemRecord, sequence: ItemId): Ratio | undefined {
    if (record.kind !== "clip" || roles.get(record.role)?.record.kind !== "video") return undefined;
    return sequences.get(sequence)?.record.rate;
  }

  // Where an item with `record` starts, or undefined when it isn't shown: a transition on a
  // removed cut, or a time past the safe integers.
  function startOf(id: ItemId, record: ItemRecord, sequence: ItemId) {
    const line = storylineOf(sequence);

    if (record.kind === "transition") {
      const cut = items.get(record.cut);
      if (cut === undefined || cut.removed || !inStoryline(cut.record)) return undefined;
      const { duration } = cut.record;
      return line.start(record.cut) + duration - Math.floor(record.duration / 2);
    }

    const { anchor } = record;
    if ("storyline" in anchor) return line.start(id);
    if ("origin" in anchor)
      return shown(() => originAnchorStart(anchor.at, snapRate(record, sequence)));
    const clip = items.get(anchor.clip)?.record;
    if (clip?.kind !== "clip") return undefined;
    const anchorClip = {
      start: line.start(anchor.clip),
      in: clip.in,
      speed: clip.speed,
      timeBase: timeBaseOf(clip),
    };
    return shown(() => clipAnchorStart(anchorClip, anchor.at, snapRate(record, sequence)));
  }

  /** Where an item starts in its sequence, in flicks, or undefined when it isn't shown. */
  function start(id: ItemId): number | undefined {
    const state = items.get(id);
    if (state === undefined || state.removed) return undefined;
    return startOf(id, state.record, state.sequence);
  }

  // A connected item must start and end at a safe integer to be placed.
  function checkPlaced(id: ItemId, record: ItemRecord, sequence: ItemId) {
    if (inStoryline(record) || record.kind === "transition") return;
    const from = startOf(id, record, sequence);

    if (from === undefined || !Number.isSafeInteger(from + record.duration)) {
      skip("malformed", "a time out of range");
    }
  }

  // What an item's change can redraw: from its start, to the end of time if it moves others (a
  // storyline item moves what follows, a connected clip can push later clips of its role to
  // other lanes), and the same for the items it places.
  function extents(id: ItemId): { sequence: ItemId; from: number; to: number }[] {
    const state = items.get(id);
    const from = start(id);
    if (state === undefined || from === undefined) return [];
    const { record, sequence } = state;
    const end =
      record.kind === "clip" || inStoryline(record)
        ? Number.POSITIVE_INFINITY
        : from + record.duration;
    const own = { sequence, from, to: end };
    if (!inStoryline(record)) return [own];
    return [own, ...live(dependents, id).flatMap(extents)];
  }

  function addItem(id: ItemId, record: ItemRecord) {
    if (items.has(id)) skip("stale", `${id} exists`);
    const sequence = sequenceFor(id, record, false);
    checkClip(record, sequence, true);
    checkPlaced(id, record, sequence);

    if (record.kind !== "transition" && "storyline" in record.anchor) {
      const { position } = record.anchor;
      guarded(() => storylineOf(sequence).insert(id, position, record.duration));
    }

    items.set(id, { record, sequence, removed: false });
    add(members, sequence, id);
    link(id, record);
  }

  function setItem(id: ItemId, path: string, value: Value) {
    const state = liveItem(id);
    const record = checked(itemSchema, withLeaf(state.record, state.record.kind, path, value));
    checkClip(record, state.sequence, false);
    checkPlaced(id, record, state.sequence);
    if (inStoryline(record))
      guarded(() => storylineOf(state.sequence).setDuration(id, record.duration));
    unlink(id, state.record);
    state.record = record;
    link(id, record);
  }

  function moveItem(id: ItemId, anchor: Anchor) {
    const state = liveItem(id);
    if (state.record.kind === "transition") skip("malformed", "a transition is placed by its cut");
    const record = { ...state.record, anchor };
    const sequence = sequenceFor(id, record, false);
    if (sequence !== state.sequence) skip("structural", "an item moves within its sequence");
    checkPlaced(id, record, sequence);
    const was = inStoryline(state.record);

    if (was && !("storyline" in anchor) && live(dependents, id).length > 0) {
      skip("structural", "a storyline item leaves the storyline while items are placed by it");
    }

    const line = storylineOf(sequence);
    if (was && "storyline" in anchor) line.move(id, anchor.position);
    else if ("storyline" in anchor)
      guarded(() => line.insert(id, anchor.position, record.duration));
    else if (was) line.remove(id);
    unlink(id, state.record);
    state.record = record;
    link(id, record);
  }

  // A removed storyline item stays in the storyline with no length, so items connected to it
  // still sit where it was.
  function removeItem(id: ItemId) {
    const state = liveItem(id);
    if (inStoryline(state.record)) storylineOf(state.sequence).setDuration(id, 0);
    state.removed = true;
  }

  function restoreItem(id: ItemId) {
    const state = items.get(id);
    if (state === undefined || !state.removed) skip("stale", `${id} isn't removed`);
    const { record, sequence } = state;
    liveSequence(sequence);
    sequenceFor(id, record, true);
    checkClip(record, sequence, true);
    checkPlaced(id, record, sequence);
    if (inStoryline(record)) guarded(() => storylineOf(sequence).setDuration(id, record.duration));
    state.removed = false;
  }

  function addAsset(record: Asset) {
    const existing = assets.get(record.id);
    if (existing !== undefined && !existing.removed) skip("stale", `${record.id} exists`);
    assets.set(record.id, { record, removed: false });
  }

  function removeAsset(id: string) {
    const state = assets.get(id);
    if (state === undefined || state.removed) skip("stale", `no asset ${id}`);
    if (live(users, id).length > 0) skip("structural", "an asset still in use");
    state.removed = true;
  }

  function addSequence(id: ItemId, record: SequenceRecord) {
    if (sequences.has(id)) skip("stale", `${id} exists`);
    checkRate(record.rate);
    sequences.set(id, { record, removed: false, storyline: createStoryline() });
  }

  function setSequence(id: ItemId, path: string, value: Value) {
    const state = liveSequence(id);
    const record = checked(sequenceSchema, withLeaf(state.record, "sequence", path, value));
    checkRate(record.rate);
    state.record = record;
  }

  function removeSequence(id: ItemId) {
    const state = liveSequence(id);
    if (live(members, id).length > 0) skip("structural", "a sequence still holds items");
    if (live(users, id).length > 0)
      skip("structural", "a sequence still played by a compound clip");
    state.removed = true;
  }

  function addRole(id: ItemId, record: RoleRecord) {
    if (roles.has(id)) skip("stale", `${id} exists`);
    liveSequence(record.sequence);
    roles.set(id, { record, removed: false });
  }

  function setRole(id: ItemId, path: string, value: Value) {
    const state = liveRole(id);
    state.record = checked(roleSchema, withLeaf(state.record, "role", path, value));
  }

  function removeRole(id: ItemId) {
    const state = liveRole(id);
    if (live(users, id).length > 0) skip("structural", "a role still in use");
    state.removed = true;
  }

  // Applies one operation, whose own id is `id`; returns the ids of the records it changed.
  function applyOne(op: Operation, id: ItemId): ItemId[] {
    switch (op.op) {
      case "project.set":
        name = op.name;
        return [];
      case "asset.add":
        addAsset(op.asset);
        return [op.asset.id];
      case "asset.remove":
        removeAsset(op.id);
        return [op.id];
      case "sequence.add":
        addSequence(id, op.sequence);
        return [id];
      case "sequence.set":
        setSequence(op.id, op.path, op.value);
        return [op.id];
      case "sequence.remove":
        removeSequence(op.id);
        return [op.id];
      case "role.add":
        addRole(id, op.role);
        return [id];
      case "role.set":
        setRole(op.id, op.path, op.value);
        return [op.id];
      case "role.remove":
        removeRole(op.id);
        return [op.id];
      case "item.add":
        addItem(id, op.item);
        return [id];
      case "item.set":
        setItem(op.id, op.path, op.value);
        return [op.id];
      case "item.move":
        moveItem(op.id, op.anchor);
        return [op.id];
      case "item.remove":
        removeItem(op.id);
        return [op.id];
      case "item.restore":
        restoreItem(op.id);
        return [op.id];
      default:
        return skip("unsupported", `${op.op} isn't applied yet`);
    }
  }

  // What an operation redraws as a whole sequence: a sequence's settings, a role's order.
  function wholeSequence(op: Operation) {
    if (op.op === "sequence.set") return op.id;
    if (op.op === "role.set" && op.path === "order") return roles.get(op.id)?.record.sequence;
    return undefined;
  }

  /** Applies a batch's operations in order, skipping any that doesn't fit the document. */
  function apply(batch: Pick<Batch, "author" | "seq" | "ops">): Applied {
    const skipped: Skip[] = [];
    const changed = new Set<ItemId>();
    const ranges = new Map<ItemId, Range>();

    function widen(span: { sequence: ItemId; from: number; to: number }) {
      const range = ranges.get(span.sequence);
      const from = Math.min(range?.from ?? span.from, span.from);
      const to = Math.max(range?.to ?? span.to, span.to);
      ranges.set(span.sequence, { from, to });
    }

    for (const [index, op] of batch.ops.entries()) {
      const id = itemId(batch.author, batch.seq, index);
      const about = subject(op, id);
      const before = about === undefined ? [] : extents(about);
      let changes: ItemId[];

      try {
        changes = applyOne(op, id);
      } catch (error) {
        if (!(error instanceof Skipped)) throw error;
        skipped.push({ index, reason: error.reason, detail: error.message });
        continue;
      }

      for (const changedId of changes) changed.add(changedId);
      const after = about === undefined ? [] : extents(about);
      for (const span of [...before, ...after]) widen(span);
      const sequence = wholeSequence(op);
      if (sequence !== undefined) widen({ sequence, ...EVERYTHING });
    }

    return { skipped, changed: [...changed], ranges };
  }

  /** An item's record and state, or undefined for an id the project never had. */
  function item(id: ItemId) {
    const state = items.get(id);
    if (state === undefined) return undefined;
    const { record } = state;
    const anchoredTo =
      record.kind !== "transition" && "clip" in record.anchor ? record.anchor.clip : undefined;
    const orphaned = anchoredTo !== undefined && items.get(anchoredTo)?.removed === true;
    return { id, ...record, sequence: state.sequence, removed: state.removed, orphaned };
  }

  /** A sequence's live storyline items in order, each with its start and duration. */
  function storyline(sequence: ItemId) {
    return [...storylineOf(sequence).items()].filter(({ id }) => items.get(id)?.removed === false);
  }

  /** The lane of each shown connected clip of a role. */
  function lanes(role: ItemId) {
    const placed = [];

    for (const id of live(users, role)) {
      const record = items.get(id)?.record;
      if (record?.kind !== "clip" || inStoryline(record)) continue;
      const from = start(id);
      if (from === undefined || !Number.isSafeInteger(from + record.duration)) continue;
      placed.push({ id, start: from, duration: record.duration, lane: record.lane });
    }

    return assignLanes(placed);
  }

  return {
    apply,
    item,
    start,
    storyline,
    lanes,
    name: () => name,
    sequence: (id: ItemId) => sequences.get(id)?.record,
    role: (id: ItemId) => roles.get(id)?.record,
    asset: (id: string) => assets.get(id)?.record,
  };
}
