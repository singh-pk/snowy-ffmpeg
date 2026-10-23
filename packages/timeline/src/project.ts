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

/** A time range of a sequence that changed, in flicks; `to` is infinite when all after `from` moved. */
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

/** An empty project. */
export function createProject() {
  let name = "";
  const assets = new Map<string, AssetState>();
  const sequences = new Map<ItemId, SequenceState>();
  const roles = new Map<ItemId, RoleState>();
  const items = new Map<ItemId, ItemState>();
  // The items anchored to each clip, removed ones included.
  const connected = new Map<ItemId, Set<ItemId>>();

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

  function storylineOf(id: ItemId) {
    const state = sequences.get(id);
    if (state === undefined) throw new RangeError(`no sequence ${id}`);
    return state.storyline;
  }

  // Whether sequence `outer` holds a compound clip of `inner`, directly or further down.
  function contains(outer: ItemId, inner: ItemId, seen = new Set<ItemId>()): boolean {
    if (seen.has(outer)) return false;
    seen.add(outer);

    for (const state of items.values()) {
      const { record } = state;
      if (state.removed || state.sequence !== outer || record.kind !== "clip") continue;
      if (!("sequence" in record.source)) continue;

      if (record.source.sequence === inner || contains(record.source.sequence, inner, seen)) {
        return true;
      }
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
    if (target === undefined || (target.removed && !orphanOk))
      skip("stale", `no item ${anchor.clip}`);

    if (anchor.clip === id || target.record.kind !== "clip" || !inStoryline(target.record)) {
      skip("structural", "connected items anchor to storyline clips");
    }

    return target.sequence;
  }

  // What a clip needs besides its anchor: a role of its sequence that takes its kind of media,
  // its asset and stream, and for a compound clip, a sequence that doesn't hold this one.
  function checkClip(record: ItemRecord, sequence: ItemId) {
    if (record.kind !== "clip") return;
    const role = roles.get(record.role);
    if (role === undefined || role.removed) skip("stale", `no role ${record.role}`);
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
    else {
      liveSequence(source.sequence);

      if (source.sequence === sequence || contains(source.sequence, sequence)) {
        skip("structural", "a compound clip would contain itself");
      }
    }

    if (kind !== undefined && kind !== role.record.kind) {
      skip("structural", `a ${kind} clip in a ${role.record.kind} role`);
    }
  }

  function liveConnected(clip: ItemId) {
    return [...(connected.get(clip) ?? [])].filter((id) => items.get(id)?.removed === false);
  }

  function link(id: ItemId, record: ItemRecord) {
    if (record.kind === "transition" || !("clip" in record.anchor)) return;
    const set = connected.get(record.anchor.clip) ?? new Set();
    set.add(id);
    connected.set(record.anchor.clip, set);
  }

  function unlink(id: ItemId, record: ItemRecord) {
    if (record.kind !== "transition" && "clip" in record.anchor) {
      connected.get(record.anchor.clip)?.delete(id);
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

  /** Where an item starts in its sequence, in flicks, or undefined for a removed one. */
  function start(id: ItemId): number | undefined {
    const state = items.get(id);
    if (state === undefined || state.removed) return undefined;
    const { record, sequence } = state;
    const line = storylineOf(sequence);

    if (record.kind === "transition") {
      const cut = items.get(record.cut);
      if (cut === undefined || cut.removed) return undefined;
      const cutDuration = cut.record.kind === "transition" ? 0 : cut.record.duration;
      return line.start(record.cut) + cutDuration - Math.floor(record.duration / 2);
    }

    const { anchor } = record;
    if ("storyline" in anchor) return line.start(id);
    if ("origin" in anchor) return originAnchorStart(anchor.at, snapRate(record, sequence));
    const clip = items.get(anchor.clip)?.record;
    if (clip?.kind !== "clip") return undefined;
    const anchorClip = {
      start: line.start(anchor.clip),
      in: clip.in,
      speed: clip.speed,
      timeBase: timeBaseOf(clip),
    };
    return clipAnchorStart(anchorClip, anchor.at, snapRate(record, sequence));
  }

  // Where a live item lies, for working out what an operation changed.
  function extent(id: ItemId) {
    const state = items.get(id);
    const from = start(id);
    if (state === undefined || from === undefined) return undefined;
    const { duration } = state.record;
    // A storyline item moves everything after it, so all after its start changes.
    const to = inStoryline(state.record) ? Number.POSITIVE_INFINITY : from + duration;
    return { sequence: state.sequence, from, to };
  }

  function addItem(id: ItemId, record: ItemRecord) {
    if (items.has(id)) skip("stale", `${id} exists`);
    const sequence = sequenceFor(id, record, false);
    checkClip(record, sequence);
    items.set(id, { record, sequence, removed: false });
    link(id, record);
    if (record.kind === "transition" || !("storyline" in record.anchor)) return;
    storylineOf(sequence).insert(id, record.anchor.position, record.duration);
  }

  function setItem(id: ItemId, path: string, value: Value) {
    const state = liveItem(id);
    const record = checked(itemSchema, withLeaf(state.record, state.record.kind, path, value));
    checkClip(record, state.sequence);
    state.record = record;

    if (record.kind !== "transition" && "storyline" in record.anchor) {
      storylineOf(state.sequence).setDuration(id, record.duration);
    }
  }

  function moveItem(id: ItemId, anchor: Anchor) {
    const state = liveItem(id);
    if (state.record.kind === "transition") skip("malformed", "a transition is placed by its cut");
    const record = { ...state.record, anchor };
    const sequence = sequenceFor(id, record, false);
    if (sequence !== state.sequence) skip("structural", "an item moves within its sequence");
    const was = inStoryline(state.record);
    const will = "storyline" in anchor;

    if (was && !will && liveConnected(id).length > 0) {
      skip("structural", "a storyline clip leaves the storyline while items are connected to it");
    }

    const line = storylineOf(sequence);
    unlink(id, state.record);
    state.record = record;
    link(id, record);
    if (was && "storyline" in anchor) line.move(id, anchor.position);
    else if (was) line.remove(id);
    else if ("storyline" in anchor) line.insert(id, anchor.position, record.duration);
  }

  // A removed storyline item stays in the storyline with no length, so items connected to it
  // still sit where it was.
  function removeItem(id: ItemId) {
    const state = liveItem(id);
    state.removed = true;
    if (inStoryline(state.record)) storylineOf(state.sequence).setDuration(id, 0);
  }

  function restoreItem(id: ItemId) {
    const state = items.get(id);
    if (state === undefined || !state.removed) skip("stale", `${id} isn't removed`);
    sequenceFor(id, state.record, true);
    checkClip(state.record, state.sequence);
    state.removed = false;
    const { record } = state;

    if (record.kind !== "transition" && "storyline" in record.anchor) {
      storylineOf(state.sequence).setDuration(id, record.duration);
    }
  }

  function setSequence(id: ItemId, path: string, value: Value) {
    const state = liveSequence(id);
    const record = checked(sequenceSchema, withLeaf(state.record, "sequence", path, value));
    checkRate(record.rate);
    state.record = record;
  }

  function setRole(id: ItemId, path: string, value: Value) {
    const state = roles.get(id);
    if (state === undefined || state.removed) skip("stale", `no role ${id}`);
    state.record = checked(roleSchema, withLeaf(state.record, "role", path, value));
  }

  function removeSequence(id: ItemId) {
    const state = liveSequence(id);

    for (const other of items.values()) {
      const { record } = other;

      if (
        !other.removed &&
        record.kind === "clip" &&
        "sequence" in record.source &&
        record.source.sequence === id
      ) {
        skip("structural", "a sequence still used by a compound clip");
      }
    }

    state.removed = true;
  }

  function removeRole(id: ItemId) {
    const state = roles.get(id);
    if (state === undefined || state.removed) skip("stale", `no role ${id}`);

    for (const other of items.values()) {
      if (!other.removed && other.record.kind === "clip" && other.record.role === id) {
        skip("structural", "a role still in use");
      }
    }

    state.removed = true;
  }

  // Applies one operation, whose own id is `id`; returns the ids of the records it changed.
  function applyOne(op: Operation, id: ItemId): ItemId[] {
    switch (op.op) {
      case "project.set":
        name = op.name;
        return [];
      case "asset.add": {
        const existing = assets.get(op.asset.id);
        if (existing !== undefined && !existing.removed) skip("stale", `${op.asset.id} exists`);
        assets.set(op.asset.id, { record: existing?.record ?? op.asset, removed: false });
        return [op.asset.id];
      }

      case "asset.remove": {
        const existing = assets.get(op.id);
        if (existing === undefined || existing.removed) skip("stale", `no asset ${op.id}`);
        existing.removed = true;
        return [op.id];
      }

      case "sequence.add":
        checkRate(op.sequence.rate);
        sequences.set(id, { record: op.sequence, removed: false, storyline: createStoryline() });
        return [id];
      case "sequence.set":
        setSequence(op.id, op.path, op.value);
        return [op.id];
      case "sequence.remove":
        removeSequence(op.id);
        return [op.id];
      case "role.add":
        liveSequence(op.role.sequence);
        roles.set(id, { record: op.role, removed: false });
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

  /** Applies a batch's operations in order, skipping any that doesn't fit the document. */
  function apply(batch: Pick<Batch, "author" | "seq" | "ops">): Applied {
    const skipped: Skip[] = [];
    const changed: ItemId[] = [];
    const ranges = new Map<ItemId, Range>();

    function widen(span: { sequence: ItemId; from: number; to: number } | undefined) {
      if (span === undefined) return;
      const range = ranges.get(span.sequence);
      const from = Math.min(range?.from ?? span.from, span.from);
      const to = Math.max(range?.to ?? span.to, span.to);
      ranges.set(span.sequence, { from, to });
    }

    for (const [index, op] of batch.ops.entries()) {
      const id = itemId(batch.author, batch.seq, index);
      const about = subject(op, id);
      const before = about === undefined ? undefined : extent(about);

      try {
        for (const changedId of applyOne(op, id)) {
          if (!changed.includes(changedId)) changed.push(changedId);
        }
      } catch (error) {
        if (!(error instanceof Skipped)) throw error;
        skipped.push({ index, reason: error.reason, detail: error.message });
        continue;
      }

      widen(before);
      if (about !== undefined) widen(extent(about));
      if (op.op === "sequence.set")
        widen({ sequence: op.id, from: 0, to: Number.POSITIVE_INFINITY });
    }

    return { skipped, changed, ranges };
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

  /** The lane of each live connected clip of a role. */
  function lanes(role: ItemId) {
    const placed = [];

    for (const [id, state] of items) {
      const { record } = state;
      if (state.removed || record.kind !== "clip" || record.role !== role || inStoryline(record))
        continue;
      placed.push({ id, start: start(id) ?? 0, duration: record.duration, lane: record.lane });
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
