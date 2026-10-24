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
  effect as effectSchema,
  type EntryRef,
  item as itemSchema,
  role as roleSchema,
  sequence as sequenceSchema,
  type Anchor,
  type Asset,
  type EffectRecord,
  type ItemRecord,
  type KeyframeRecord,
  type RoleRecord,
  type SequenceRecord,
  type Value,
} from "./document";
import { itemId, type ItemId } from "./ids";
import { assignLanes, clipAnchorStart, originAnchorStart, transitionHalves } from "./layout";
import { InvalidError } from "./schema";
import { keyBetween } from "./position";
import { createStoryline } from "./storyline";
import { FLICKS_PER_SECOND, flicksToSource, frameFlicks, type Ratio } from "./time";

type Operation = Batch["ops"][number];
type Merge = Extract<Operation, { op: "branch.merge" }>;

/** Why an operation was skipped: the kinds docs/architecture.md#applying names. */
type SkipReason = "malformed" | "stale" | "structural" | "unsupported" | "waiting";

/** An operation of a batch that applying skipped, by its index in the batch. */
type Skip = { index: number; reason: SkipReason; detail: string };

/** A time range of a sequence that changed, in flicks; infinite at an end that reaches all the way. */
export type Range = { from: number; to: number };

/** A batch a merge brought, by the merge's index, with the operations of it that were skipped. */
type Merged = { index: number; batch: Pick<Batch, "author" | "seq" | "ops">; skipped: Skip[] };

/** What applying a batch did. */
export type Applied = {
  skipped: Skip[];
  /** The batches merges brought that the document didn't have, in the order applied. */
  merged: Merged[];
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
type EffectState = { record: EffectRecord; removed: boolean };
type Clip = Extract<ItemRecord, { kind: "clip" }>;

/** What a peer reads of a document: everything but applying. */
export type Document = Omit<ReturnType<typeof createProject>, "apply">;

/** The document at an entry of the branch, or undefined for one it doesn't have. */
type AtEntry = (ref: EntryRef) => Snapshot | undefined;

/**
 * What applying needs from the history: the branch applied to, the document at an entry of it,
 * for a revert, and the batches a merge brings, in their branch's order; "missing" while this peer
 * doesn't have every entry the merge names, "stale" for entries it never will.
 */
export type Resolver = {
  branch: Batch["branch"];
  at: AtEntry;
  merged: (op: Merge) => ReadonlyArray<Pick<Batch, "author" | "seq" | "ops">> | "missing" | "stale";
};

// Each author's applied seqs as sorted, disjoint [first, last] runs. An author's seqs come mostly
// in order, so there are few runs, and a snapshot shares them instead of copying every batch.
// Runs are never changed, only replaced.
type Runs = ReadonlyArray<readonly [number, number]>;

const holds = (runs: Runs | undefined, seq: number) =>
  runs?.some(([first, end]) => first <= seq && seq <= end) === true;

// `runs` with `seq` added, joining the runs it meets.
function withSeq(runs: Runs, seq: number): Runs {
  const before = runs.filter(([, end]) => end < seq - 1);
  const after = runs.filter(([first]) => first > seq + 1);
  const touching = runs.filter(([first, end]) => first <= seq + 1 && end >= seq - 1);
  const first = Math.min(seq, ...touching.map(([from]) => from));
  const end = Math.max(seq, ...touching.map(([, to]) => to));
  return [...before, [first, end], ...after];
}

/** A project's whole state as plain data, which a new project can start from. */
export type Snapshot = {
  name: string;
  assets: AssetState[];
  sequences: Array<{ id: ItemId; record: SequenceRecord; removed: boolean }>;
  roles: Array<RoleState & { id: ItemId }>;
  items: Array<ItemState & { id: ItemId }>;
  effects: Array<EffectState & { id: ItemId }>;
  keyframes: KeyframeRecord[];
  /** Every batch applied to the document, merged ones included: each author's runs of seqs. */
  batches: Array<{ author: string; runs: Runs }>;
};

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
  effect: new Set(["position", "enabled", "params"]),
};

// The fields of a clip a keyframe may animate: its picture, its sound and its generator's
// parameters, never its timing or its place.
const ANIMATED = /^(video|audio|source\.params)\./;

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

/**
 * The leaf at `path` of a record, reading an absent `video` or `audio` as its defaults, as
 * setting one of its leaves fills them in; undefined for a leaf the record doesn't have.
 */
export function leafOf(record: object, path: string): Value | undefined {
  const [root = "", ...rest] = path.split(".");
  let node: unknown = isObject(record) ? (record[root] ?? DEFAULTS[root]) : undefined;

  for (const segment of rest) {
    if (!isObject(node)) return undefined;
    node = node[segment];
  }

  return isValue(node) ? node : undefined;
}

function isValue(value: unknown): value is Value {
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return true;
  return Array.isArray(value) && value.every(isValue);
}

const byId = (state: { id: ItemId }) => state.id;

// Adds to `target`'s states those only `now` has, removed, so a revert keeps their ids taken.
function withRemoved<T extends { removed: boolean }>(
  target: T[],
  now: T[],
  idOf: (state: T) => string,
) {
  const kept = new Set(target.map(idOf));
  const states = [...target];

  for (const state of now) {
    if (!kept.has(idOf(state))) states.push({ ...state, removed: true });
  }

  return states;
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
  if ((op.op.startsWith("item.") || op.op.startsWith("clip.")) && "id" in op) return op.id;
  return undefined;
}

// Strings in UTF-16 code unit order, never by locale, as storylines order position keys.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Whether a parameter's new value is of the type its old one was.
const sameType = (a: Value, b: Value) =>
  typeof a === typeof b && Array.isArray(a) === Array.isArray(b);

const keyframeKey = (param: string, at: number) => `${param} ${at}`;

// Whether a source point is in the second piece of a clip split at `point`: the second piece
// plays on from it, upwards, or downwards in reverse.
const pastSplit = (at: number, point: number, clip: Clip) =>
  clip.speed[0] > 0 ? at >= point : at <= point;

// A clip with one of its fades set to `length`; a clip without audio has none.
function withFade(clip: Clip, fade: "fadeIn" | "fadeOut", length: number) {
  return clip.audio === undefined ? clip : { ...clip, audio: { ...clip.audio, [fade]: length } };
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

/** A project's document, empty or as a snapshot left it. */
export function createProject(initial?: Snapshot) {
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
  const effects = new Map<ItemId, EffectState>();
  // Each clip's effects, removed ones included.
  const chains = new Map<ItemId, Set<ItemId>>();
  // Each target's keyframes, by param and source point.
  const keyframes = new Map<ItemId, Map<string, KeyframeRecord>>();
  // The batches applied, so a merge brings each batch once, however the branches were merged.
  const batches = new Map<string, Runs>();

  const has = (batch: { author: string; seq: number }) =>
    holds(batches.get(batch.author), batch.seq);

  function hold(batch: { author: string; seq: number }) {
    batches.set(batch.author, withSeq(batches.get(batch.author) ?? [], batch.seq));
  }

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
      const rate = sequences.get(sequence)?.record.rate;
      if (rate === undefined) return undefined;
      return line.start(record.cut) + duration - transitionHalves(record.duration, rate).before;
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

  function liveClip(id: ItemId) {
    const state = liveItem(id);
    if (state.record.kind !== "clip") skip("structural", `${id} isn't a clip`);
    return { state, clip: state.record };
  }

  // Gives item `id` a new record, keeping the indexes in step.
  function replace(id: ItemId, record: ItemRecord) {
    const state = items.get(id);
    if (state === undefined) throw new RangeError(`no item ${id}`);
    unlink(id, state.record);
    state.record = record;
    link(id, record);
  }

  // Where the second piece of `clip` goes, `offset` flicks into it: next in the storyline, or
  // that much later on its anchor.
  function pieceAnchor(clip: Clip, offset: number, sequence: ItemId): Anchor {
    const { anchor } = clip;

    if ("storyline" in anchor) {
      const after = storylineOf(sequence).keyAfter(anchor.position);
      return { ...anchor, position: keyBetween(anchor.position, after) };
    }

    if ("origin" in anchor) return { ...anchor, at: anchor.at + offset };
    const parent = items.get(anchor.clip)?.record;
    if (parent?.kind !== "clip") skip("stale", `no clip ${anchor.clip}`);
    return { ...anchor, at: anchor.at + flicksToSource(offset, timeBaseOf(parent), parent.speed) };
  }

  // Moves what a split or a join hands from one piece to the other: the connected items at
  // source points `moves` picks, a transition on the cut, and the clip's own keyframes.
  function handOver(from: ItemId, to: ItemId, moves: (at: number) => boolean) {
    const moved: ItemId[] = [];

    // A copy, since moving one changes the set.
    for (const dependent of Array.from(dependents.get(from) ?? [])) {
      const record = items.get(dependent)?.record;
      if (record === undefined) continue;

      if (record.kind === "transition") replace(dependent, { ...record, cut: to });
      else if ("clip" in record.anchor && moves(record.anchor.at)) {
        replace(dependent, { ...record, anchor: { clip: to, at: record.anchor.at } });
      } else continue;

      moved.push(dependent);
    }

    const own = keyframes.get(from);
    const target = keyframes.get(to) ?? new Map<string, KeyframeRecord>();

    for (const [key, keyframe] of own ?? []) {
      if (!moves(keyframe.at)) continue;
      own?.delete(key);
      if (!target.has(key)) target.set(key, { ...keyframe, target: to });
    }

    if (target.size > 0) keyframes.set(to, target);
    return moved;
  }

  // Whether a live storyline item shares the clip's position key after it: a piece can't be
  // put between the two, since order within a key is by id.
  function tiedAfter(id: ItemId, position: string, sequence: ItemId) {
    const line = storylineOf(sequence);

    for (let next = line.next(id); next !== undefined; next = line.next(next)) {
      const state = items.get(next);
      const record = state?.record;
      if (record === undefined || record.kind === "transition" || !("storyline" in record.anchor))
        break;
      if (record.anchor.position !== position) break;
      if (!state?.removed) return true;
    }

    return false;
  }

  // Splits a clip at a timeline time: it keeps what is before, and a new clip, `piece`, takes
  // what is after. Where the piece's anchor lands, rounded to its anchor's units and snapped to a
  // frame, is where the split falls, so the two pieces always meet.
  function splitClip(id: ItemId, at: number, piece: ItemId) {
    if (items.has(piece)) skip("stale", `${piece} exists`);
    const { state, clip } = liveClip(id);
    const { sequence } = state;
    const from = start(id);
    const wanted = from === undefined ? 0 : at - from;
    if (wanted <= 0 || wanted >= clip.duration) skip("stale", "the clip doesn't cover the time");
    const anchor = guarded(() => pieceAnchor(clip, wanted, sequence));
    if ("at" in anchor && !Number.isSafeInteger(anchor.at))
      skip("malformed", "a time out of range");

    if ("storyline" in anchor && "storyline" in clip.anchor) {
      if (tiedAfter(id, clip.anchor.position, sequence)) {
        skip("structural", "another item shares the clip's position key after it");
      }
    }

    const lands = "storyline" in anchor ? at : startOf(piece, { ...clip, anchor }, sequence);
    const offset = lands === undefined || from === undefined ? 0 : lands - from;
    if (offset <= 0 || offset >= clip.duration) skip("stale", "the clip doesn't cover the time");
    const point = guarded(() => clip.in + flicksToSource(offset, timeBaseOf(clip), clip.speed));
    if (!Number.isSafeInteger(point)) skip("malformed", "a source point out of range");
    const first = withFade({ ...clip, duration: offset }, "fadeOut", 0);
    const rest = { ...clip, in: point, duration: clip.duration - offset, anchor };
    const second = withFade(rest, "fadeIn", 0);
    if (inStoryline(clip)) storylineOf(sequence).setDuration(id, offset);
    if ("storyline" in anchor)
      storylineOf(sequence).insert(piece, anchor.position, second.duration);
    replace(id, first);
    items.set(piece, { record: second, sequence, removed: false });
    add(members, sequence, piece);
    link(piece, second);
    return [id, piece, ...handOver(id, piece, (source) => pastSplit(source, point, clip))];
  }

  // Whether `next` starts where `clip` ends, on the same anchor.
  function meets(id: ItemId, clip: Clip, nextId: ItemId, next: Clip) {
    const a = clip.anchor;
    const b = next.anchor;
    const end = (start(id) ?? 0) + clip.duration;

    if ("storyline" in a || "storyline" in b) {
      return (
        "storyline" in a && "storyline" in b && storylineOf(a.storyline).at(end)?.id === nextId
      );
    }

    const sameAnchor =
      "origin" in a ? "origin" in b && a.origin === b.origin : "clip" in b && a.clip === b.clip;
    return sameAnchor && start(nextId) === end;
  }

  // Joins two pieces of one source that meet exactly, as a split left them, back into the first.
  function joinClips(id: ItemId, nextId: ItemId) {
    const { state, clip } = liveClip(id);
    const { state: nextState, clip: next } = liveClip(nextId);
    if (id === nextId) skip("malformed", "a clip joins another");

    if (
      state.sequence !== nextState.sequence ||
      clip.role !== next.role ||
      !same(clip.source, next.source) ||
      !same(clip.speed, next.speed)
    ) {
      skip("structural", "only pieces of one clip join");
    }

    const point = guarded(
      () => clip.in + flicksToSource(clip.duration, timeBaseOf(clip), clip.speed),
    );
    if (next.in !== point || !meets(id, clip, nextId, next)) skip("stale", "the pieces don't meet");

    if (live(dependents, id).some((each) => items.get(each)?.record.kind === "transition")) {
      skip("structural", "a transition sits on the cut");
    }

    const own = keyframes.get(id);

    for (const key of keyframes.get(nextId)?.keys() ?? []) {
      if (own?.has(key) === true) skip("stale", "both pieces have a keyframe at one source point");
    }

    const joined = { ...clip, duration: clip.duration + next.duration };
    const record =
      next.audio === undefined ? joined : withFade(joined, "fadeOut", next.audio.fadeOut);
    const line = storylineOf(state.sequence);

    if (inStoryline(clip)) {
      line.setDuration(nextId, 0);
      line.setDuration(id, record.duration);
    }

    replace(id, record);
    nextState.removed = true;
    return [id, nextId, ...handOver(nextId, id, () => true)];
  }

  function addEffect(id: ItemId, record: EffectRecord) {
    if (effects.has(id)) skip("stale", `${id} exists`);
    liveClip(record.clip);
    effects.set(id, { record, removed: false });
    add(chains, record.clip, id);
  }

  // A live effect of a live clip.
  function liveEffect(id: ItemId) {
    const state = effects.get(id);
    if (state === undefined || state.removed) skip("stale", `no effect ${id}`);
    liveClip(state.record.clip);
    return state;
  }

  function setEffect(id: ItemId, path: string, value: Value) {
    const state = liveEffect(id);
    const old = path.startsWith("params.") ? state.record.params[path.slice(7)] : undefined;
    if (old !== undefined && !sameType(old, value)) skip("malformed", `${path} takes another type`);
    state.record = checked(effectSchema, withLeaf(state.record, "effect", path, value));
  }

  // A keyframe's target and param must name a live value of its type: an effect's parameter, or
  // an animated field of a clip.
  function checkKeyframe(target: ItemId, param: string, value: Value) {
    const effect = effects.get(target);

    if (effect !== undefined) {
      liveEffect(target);
      const old = effect.record.params[param];
      if (old === undefined) skip("stale", `no parameter ${param} in ${target}`);
      if (!sameType(old, value)) skip("malformed", `${param} takes another type`);
      return;
    }

    const { clip } = liveClip(target);
    if (!ANIMATED.test(param)) skip("malformed", `${param} isn't animated`);
    checked(itemSchema, withLeaf(clip, "clip", param, value));
  }

  function setKeyframe(keyframe: KeyframeRecord) {
    checkKeyframe(keyframe.target, keyframe.param, keyframe.value);
    const own = keyframes.get(keyframe.target) ?? new Map<string, KeyframeRecord>();
    own.set(keyframeKey(keyframe.param, keyframe.at), keyframe);
    keyframes.set(keyframe.target, own);
  }

  function removeKeyframe(target: ItemId, param: string, at: number) {
    if (keyframes.get(target)?.delete(keyframeKey(param, at)) !== true) {
      skip("stale", `no keyframe of ${param} at ${at} on ${target}`);
    }
  }

  // Sets the document back to a snapshot's state. What the snapshot doesn't have is removed, not
  // forgotten, so its id stays taken and its state kept.
  function revertTo(target: Snapshot): ItemId[] {
    const now = snapshot();
    const state: Snapshot = {
      name: target.name,
      assets: withRemoved(target.assets, now.assets, ({ record }) => record.id),
      sequences: withRemoved(target.sequences, now.sequences, byId),
      roles: withRemoved(target.roles, now.roles, byId),
      items: withRemoved(target.items, now.items, byId),
      effects: withRemoved(target.effects, now.effects, byId),
      keyframes: target.keyframes,
      // The batches stay applied: merging one again would bring back what the revert took away.
      batches: now.batches,
    };
    for (const index of [assets, sequences, roles, items, members, dependents, users])
      index.clear();
    for (const index of [effects, chains, keyframes]) index.clear();
    load(state);
    return [
      ...state.sequences.map(byId),
      ...state.roles.map(byId),
      ...state.items.map(byId),
      ...state.effects.map(byId),
      ...state.assets.map(({ record }) => record.id),
    ];
  }

  // Applies one operation, whose own id is `id`; returns the ids of the records it changed. A
  // revert and the branch operations need the history; a merge is applied by `apply`.
  function applyOne(op: Operation, id: ItemId, history: Resolver | undefined): ItemId[] {
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
      case "clip.split":
        return splitClip(op.id, op.at, id);
      case "clip.join":
        return joinClips(op.id, op.next);
      case "effect.add":
        addEffect(id, op.effect);
        return [id];
      case "effect.set":
        setEffect(op.id, op.path, op.value);
        return [op.id];
      case "effect.remove":
        liveEffect(op.id).removed = true;
        return [op.id];
      case "keyframe.set":
        setKeyframe(op.keyframe);
        return [op.keyframe.target];
      case "keyframe.remove":
        removeKeyframe(op.target, op.param, op.at);
        return [op.target];
      case "revert": {
        if (history === undefined) skip("unsupported", "a revert is applied by the history");
        const target = history.at(op.to);
        if (target === undefined) skip("stale", `no entry ${op.to.n} with that hash`);
        return revertTo(target);
      }
      case "branch.create":
      case "branch.close":
        // The history opens or closes the branch; the document doesn't change.
        if (history === undefined) skip("unsupported", `${op.op} is applied by the history`);
        if (op.op === "branch.close" && op.branch === "main")
          skip("structural", "main can't close");
        return [];
      default:
        return skip("unsupported", `${op.op} is applied by the history`);
    }
  }

  // What an operation redraws as a whole sequence: a sequence's settings, a role's order; and
  // what a revert redraws: every sequence.
  function wholeSequences(op: Operation): ItemId[] {
    if (op.op === "revert") return [...sequences.keys()];
    if (op.op === "sequence.set") return [op.id];
    const sequence = op.op === "role.set" && op.path === "order" ? roles.get(op.id) : undefined;
    return sequence === undefined ? [] : [sequence.record.sequence];
  }

  // The clip whose look or sound an effect or keyframe operation changes, in place.
  function touched(op: Operation) {
    let target: ItemId | undefined;
    if (op.op === "effect.add") return op.effect.clip;
    if (op.op === "effect.set" || op.op === "effect.remove") target = op.id;
    else if (op.op === "keyframe.set") target = op.keyframe.target;
    else if (op.op === "keyframe.remove") target = op.target;
    else return undefined;
    return effects.get(target)?.record.clip ?? target;
  }

  // Where an item plays, if it is shown.
  function playing(id: ItemId) {
    const state = items.get(id);
    const from = start(id);
    if (state === undefined || from === undefined) return [];
    return [{ sequence: state.sequence, from, to: from + state.record.duration }];
  }

  /**
   * Applies a batch's operations in order, skipping any that doesn't fit the document. `history`
   * resolves reverts and merges; without it they, and the other branch operations, are skipped.
   */
  function apply(batch: Pick<Batch, "author" | "seq" | "ops">, history?: Resolver): Applied {
    const skipped: Skip[] = [];
    const merged: Merged[] = [];
    const changed = new Set<ItemId>();
    const ranges = new Map<ItemId, Range>();
    hold(batch);

    function widen(span: { sequence: ItemId; from: number; to: number }) {
      const range = ranges.get(span.sequence);
      const from = Math.min(range?.from ?? span.from, span.from);
      const to = Math.max(range?.to ?? span.to, span.to);
      ranges.set(span.sequence, { from, to });
    }

    // Applies one operation, recording what it changed, or records it in `skips` as skipped. One
    // a merge brought, the merge being the batch's operation `within`, merges in turn, but
    // doesn't revert or open or close a branch: those name its own branch's entries.
    function step(op: Operation, id: ItemId, index: number, skips: Skip[], within?: number) {
      const about = subject(op, id);
      const clip = touched(op);
      const before = [
        ...(about === undefined ? [] : extents(about)),
        ...(clip === undefined ? [] : playing(clip)),
      ];

      try {
        const names = op.op === "revert" || op.op === "branch.create" || op.op === "branch.close";
        if (within !== undefined && names)
          skip("unsupported", `${op.op} names another branch's entries`);
        if (op.op === "branch.merge" && history !== undefined)
          merge(op, within ?? index, history, within === undefined);
        else for (const changedId of applyOne(op, id, history)) changed.add(changedId);
      } catch (error) {
        if (!(error instanceof Skipped)) throw error;
        skips.push({ index, reason: error.reason, detail: error.message });
        return;
      }

      const after = [
        ...(about === undefined ? [] : extents(about)),
        ...(clip === undefined ? [] : playing(clip)),
      ];
      for (const span of [...before, ...after]) widen(span);
      for (const sequence of wholeSequences(op)) widen({ sequence, ...EVERYTHING });
    }

    // Applies the batches a merge, the batch's operation `index`, brings that the document
    // doesn't have yet, each operation with the id it has on its own branch.
    function merge(op: Merge, index: number, resolver: Resolver, own: boolean) {
      if (own && op.branch === resolver.branch) skip("structural", "a branch can't merge itself");
      const found = resolver.merged(op);
      if (found === "missing") skip("waiting", `entries of ${op.branch} aren't here yet`);
      if (found === "stale") skip("stale", `no such entries of ${op.branch}`);

      for (const each of found) {
        if (has(each)) continue;
        hold(each);
        // Listed before the batches its own merges bring.
        const inner: Skip[] = [];
        merged.push({ index, batch: each, skipped: inner });

        for (const [i, mergedOp] of each.ops.entries()) {
          step(mergedOp, itemId(each.author, each.seq, i), i, inner, index);
        }
      }
    }

    for (const [index, op] of batch.ops.entries()) {
      step(op, itemId(batch.author, batch.seq, index), index, skipped);
    }

    return { skipped, merged, changed: [...changed], ranges };
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

  const present = (id: ItemId) => items.get(id)?.removed === false;

  /**
   * A sequence's live storyline items in order, each with its start and duration; with `range`,
   * only those that play in it or start at its end, found from the item at its start.
   */
  function storyline(sequence: ItemId, range?: Range) {
    const line = storylineOf(sequence);
    if (range === undefined) return [...line.items()].filter(({ id }) => present(id));
    const found: Array<{ id: ItemId; start: number; duration: number }> = [];
    const first = line.at(Math.max(range.from, 0));
    let id = first?.id;
    let from = first?.start ?? 0;

    while (id !== undefined && from <= range.to) {
      const duration = present(id) ? (items.get(id)?.record.duration ?? 0) : 0;
      if (present(id)) found.push({ id, start: from, duration });
      from += duration;
      id = line.next(id);
    }

    return found;
  }

  /** The live storyline item before a storyline item, with its start and duration, if any. */
  function itemBefore(id: ItemId) {
    const state = items.get(id);
    if (state === undefined) return undefined;
    const line = storylineOf(state.sequence);
    let found = line.has(id) ? line.previous(id) : undefined;
    while (found !== undefined && !present(found)) found = line.previous(found);
    if (found === undefined) return undefined;
    const duration = items.get(found)?.record.duration ?? 0;
    return { id: found, start: line.start(found), duration };
  }

  /** The live transitions on the end of a storyline item, by id. */
  function transitions(cut: ItemId) {
    const found = [];

    for (const id of live(dependents, cut)) {
      const record = items.get(id)?.record;
      if (record?.kind === "transition") found.push(Object.assign({ id }, record));
    }

    return found.toSorted((a, b) => byCodeUnit(a.id, b.id));
  }

  /** Each shown connected clip of a role, with its start, duration and lane. */
  function connected(role: ItemId) {
    const placed = [];

    for (const id of live(users, role)) {
      const record = items.get(id)?.record;
      if (record?.kind !== "clip" || inStoryline(record)) continue;
      const from = start(id);
      if (from === undefined || !Number.isSafeInteger(from + record.duration)) continue;
      placed.push({ id, start: from, duration: record.duration, lane: record.lane });
    }

    const assigned = assignLanes(placed);
    for (const each of placed) each.lane = assigned.get(each.id) ?? each.lane;
    return placed;
  }

  /** The lane of each shown connected clip of a role. */
  const lanes = (role: ItemId) => new Map(connected(role).map(({ id, lane }) => [id, lane]));

  /** A clip's live effects in chain order, by position and then id, each with its id. */
  function chain(clip: ItemId) {
    const found = [];

    for (const id of chains.get(clip) ?? []) {
      const state = effects.get(id);
      if (state !== undefined && !state.removed) found.push({ id, ...state.record });
    }

    return found.toSorted((a, b) =>
      a.position === b.position ? byCodeUnit(a.id, b.id) : byCodeUnit(a.position, b.position),
    );
  }

  /** The whole state, to start another project from. Records are shared, never changed. */
  function snapshot(): Snapshot {
    const state: Snapshot = {
      name,
      assets: [],
      sequences: [],
      roles: [],
      items: [],
      effects: [],
      keyframes: [],
      batches: [...batches].map(([author, runs]) => ({ author, runs })),
    };
    for (const { record, removed } of assets.values()) state.assets.push({ record, removed });
    for (const [id, { record, removed }] of sequences)
      state.sequences.push({ id, record, removed });
    for (const [id, { record, removed }] of roles) state.roles.push({ id, record, removed });

    for (const [id, { record, sequence, removed }] of items) {
      state.items.push({ id, record, sequence, removed });
    }

    for (const [id, { record, removed }] of effects) state.effects.push({ id, record, removed });
    for (const own of keyframes.values()) state.keyframes.push(...own.values());
    return state;
  }

  // Takes a snapshot's state, building the indexes and storylines again; a removed storyline
  // item has no length, as removing it left it.
  function load(state: Snapshot) {
    name = state.name;
    for (const { author, runs } of state.batches) batches.set(author, runs);
    for (const asset of state.assets) assets.set(asset.record.id, { ...asset });

    for (const { id, record, removed } of state.sequences) {
      sequences.set(id, { record, removed, storyline: createStoryline() });
    }

    for (const { id, ...role } of state.roles) roles.set(id, role);

    for (const { id, ...rest } of state.items) {
      const { record, sequence, removed } = rest;
      items.set(id, { record, sequence, removed });
      add(members, sequence, id);
      link(id, record);
      if (record.kind === "transition" || !("storyline" in record.anchor)) continue;
      storylineOf(sequence).insert(id, record.anchor.position, removed ? 0 : record.duration);
    }

    for (const { id, ...effect } of state.effects) {
      effects.set(id, effect);
      add(chains, effect.record.clip, id);
    }

    for (const keyframe of state.keyframes) {
      const own = keyframes.get(keyframe.target) ?? new Map<string, KeyframeRecord>();
      own.set(keyframeKey(keyframe.param, keyframe.at), keyframe);
      keyframes.set(keyframe.target, own);
    }
  }

  if (initial !== undefined) load(initial);

  /** The record with an id, of any kind, and whether it is removed. */
  function recordOf(id: string): { record: object; removed: boolean } | undefined {
    const found = items.get(id) ?? sequences.get(id) ?? roles.get(id) ?? effects.get(id);
    const { record, removed } = found ?? assets.get(id) ?? {};
    return record === undefined ? undefined : { record, removed: removed === true };
  }

  return {
    apply,
    snapshot,
    /** Whether a batch is applied to the document, itself or by a merge. */
    has,
    record: recordOf,
    item,
    start,
    storyline,
    lanes,
    connected,
    itemBefore,
    transitions,
    /** A sequence's length: its storyline's, in flicks. */
    length: (sequence: ItemId) => sequences.get(sequence)?.storyline.duration() ?? 0,
    /** The time base a clip's source points are in: its stream's, or flicks'. */
    timeBase: timeBaseOf,
    name: () => name,
    sequence: (id: ItemId) => sequences.get(id)?.record,
    role: (id: ItemId) => roles.get(id)?.record,
    /** A sequence's live roles, each with its id, in order, by `order` and then id. */
    roles: (sequence: ItemId) =>
      [...roles]
        .filter(([, state]) => !state.removed && state.record.sequence === sequence)
        .map(([id, { record }]) => Object.assign({ id }, record))
        .toSorted((a, b) =>
          a.order === b.order ? byCodeUnit(a.id, b.id) : byCodeUnit(a.order, b.order),
        ),
    asset: (id: string) => assets.get(id)?.record,
    effects: chain,
    /** The keyframes on a clip or effect, by param and then source point. */
    keyframes: (target: ItemId) =>
      [...(keyframes.get(target)?.values() ?? [])].toSorted((a, b) =>
        a.param === b.param ? a.at - b.at : byCodeUnit(a.param, b.param),
      ),
  };
}
