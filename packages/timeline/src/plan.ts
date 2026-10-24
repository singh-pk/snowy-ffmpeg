// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render plan (docs/architecture.md#queries-and-the-render-plan): what @snowy-media/engine
// plays and exports for a range of a sequence. The range is cut into segments in which the set of
// layers doesn't change; each layer says how to read its source and how to draw or mix it, with
// every keyframe at its time on the timeline. Times are microseconds from here on, converted from
// flicks once each; source points stay in their stream's units.

import type { ItemRecord, KeyframeRecord, SequenceRecord, Value } from "./document";
import type { ItemId } from "./ids";
import type { Document } from "./project";
import { leafOf } from "./project";
import { flicksToMicros, sourceToFlicks, type Ratio } from "./time";

type Clip = Extract<ItemRecord, { kind: "clip" }>;
type Blend = NonNullable<Clip["video"]>["blend"];

/** A keyframe at its time on the timeline, in microseconds. */
type PlannedKeyframe = { at: number; value: Value; ease: KeyframeRecord["ease"] };

/** A parameter: its value, or its keyframes in time order when it is animated. */
type Animated = Value | { keyframes: PlannedKeyframe[] };

/** An effect of a clip's chain, with its parameters. */
type PlannedEffect = { id: ItemId; kind: string; params: Record<string, Animated> };

/**
 * How a layer reads its source: the clip's in-point in its stream's `timeBase` (flicks for a
 * generator or a sequence), played from `start` on the timeline, in microseconds, at `speed`.
 * A source time is `in + (t − start) × speed`, in seconds converted to `timeBase`.
 */
type Layer = {
  clip: ItemId;
  source:
    | { asset: string; stream: number }
    | { generator: string; params: Record<string, Animated> }
    | { sequence: ItemId };
  in: number;
  timeBase: Ratio;
  start: number;
  speed: Ratio;
  effects: PlannedEffect[];
};

/** A video layer: a layer, drawn with its opacity, blend and transform. */
type VideoLayer = Layer & {
  opacity: Animated;
  blend: Blend;
  transform: { x: Animated; y: Animated; scaleX: Animated; scaleY: Animated; rotation: Animated };
};

/** An audio layer: a layer, mixed with its gain and pan, faded, into its role's bus. */
type AudioLayer = Layer & {
  gainDb: Animated;
  pan: Animated;
  /** Where the fade in ends and the fade out starts, in microseconds. */
  fadeIn: number;
  fadeOut: number;
  bus: ItemId;
};

/**
 * A part of the range in which the same layers play: video bottom to top, and audio. A layer
 * that plays on into the next segment is the same object there.
 */
type Segment = { from: number; to: number; video: VideoLayer[]; audio: AudioLayer[] };

/** The plan of a range: the sequence, its segments, and the layers that start where it ends. */
type Plan = {
  sequence: SequenceRecord & { id: ItemId };
  segments: Segment[];
  next: Array<VideoLayer | AudioLayer>;
};

// A clip as placed, with what orders it among the others: the storyline first, then each role in
// order, then each lane from the lowest up.
type Placed = {
  clip: Clip & { id: ItemId };
  from: number;
  to: number;
  order: number[];
  video: boolean;
};

const byOrder = (a: Placed, b: Placed) => {
  for (const [i, value] of a.order.entries()) {
    const other = b.order[i] ?? 0;
    if (value !== other) return value - other;
  }

  return 0;
};

/**
 * The render plan of `sequence` from `from` to `to`, in flicks, or undefined for a sequence the
 * document doesn't have. Disabled clips, clips of no length, gaps and markers play nothing.
 * Throws a RangeError for a range that ends before it starts.
 */
export function plan(document: Document, sequence: ItemId, from: number, to: number) {
  if (to < from) throw new RangeError(`a range from ${from} to ${to}`);
  const record = document.sequence(sequence);
  if (record === undefined) return undefined;
  // In compositing order, so a segment's layers keep that order as they come and go.
  const placed = placedClips(document, sequence, from, to);
  const layers = new Map(placed.map((each) => [each, layerOf(document, each)]));
  const cuts = new Set([from, to]);

  for (const each of placed) {
    if (each.from > from && each.from < to) cuts.add(each.from);
    if (each.to > from && each.to < to) cuts.add(each.to);
  }

  const bounds = [...cuts].toSorted((a, b) => a - b);
  const segments: Segment[] = [];

  for (const [i, start] of bounds.slice(0, -1).entries()) {
    const end = bounds[i + 1] ?? to;
    const segment: Segment = {
      from: flicksToMicros(start),
      to: flicksToMicros(end),
      video: [],
      audio: [],
    };

    for (const [each, layer] of layers) {
      if (each.from > start || each.to < end) continue;
      if ("opacity" in layer) segment.video.push(layer);
      else segment.audio.push(layer);
    }

    segments.push(segment);
  }

  const next = placed.filter((each) => each.from === to).flatMap((each) => layers.get(each) ?? []);
  return { sequence: { id: sequence, ...record }, segments, next } satisfies Plan;
}

// Every enabled clip of a sequence that plays between `from` and `to`, or starts at `to`, with
// its place, in compositing order.
function placedClips(document: Document, sequence: ItemId, from: number, to: number) {
  const placed: Placed[] = [];
  const roles = document.roles(sequence);
  const kinds = new Map(roles.map((role) => [role.id, role.kind]));

  const take = (id: ItemId, start: number, order: number[]) => {
    const clip = document.item(id);
    if (clip?.kind !== "clip" || !clip.enabled || clip.duration === 0) return;
    const end = start + clip.duration;
    if (end <= from || start > to) return;
    placed.push({ clip, from: start, to: end, order, video: kinds.get(clip.role) === "video" });
  };

  for (const { id, start } of document.storyline(sequence, { from, to })) take(id, start, [0]);

  for (const [index, role] of roles.entries()) {
    for (const { id, start, lane } of document.connected(role.id)) {
      take(id, start, [1, index, lane]);
    }
  }

  return placed.toSorted(byOrder);
}

// A parameter at `param`: its keyframes among `keyframes`, on the timeline in time order, if it
// has any, else `value`. At a negative speed, source order is the reverse of time order.
function animated(
  document: Document,
  { clip, from }: Placed,
  keyframes: readonly KeyframeRecord[],
  param: string,
  value: Value,
): Animated {
  const own = keyframes.filter((each) => each.param === param);
  if (own.length === 0) return value;
  const timeBase = document.timeBase(clip);
  const planned = own.map(({ at, value: then, ease }) => ({
    at: flicksToMicros(from + sourceToFlicks(at - clip.in, timeBase, clip.speed)),
    value: then,
    ease,
  }));
  return { keyframes: planned.toSorted((a, b) => a.at - b.at) };
}

function paramsOf(
  document: Document,
  each: Placed,
  target: ItemId,
  values: Record<string, Value>,
  prefix = "",
) {
  const keyframes = document.keyframes(target);
  const found: Record<string, Animated> = {};

  for (const [name, value] of Object.entries(values)) {
    found[name] = animated(document, each, keyframes, `${prefix}${name}`, value);
  }

  return found;
}

function layerOf(document: Document, each: Placed): VideoLayer | AudioLayer {
  const { clip } = each;
  const { source } = clip;
  const effects = document
    .effects(clip.id)
    .filter((effect) => effect.enabled)
    .map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      params: paramsOf(document, each, effect.id, effect.params),
    }));
  const planned: Layer["source"] =
    "generator" in source
      ? {
          generator: source.generator,
          params: paramsOf(document, each, clip.id, source.params, "source.params."),
        }
      : source;
  const layer: Layer = {
    clip: clip.id,
    source: planned,
    in: clip.in,
    timeBase: document.timeBase(clip),
    start: flicksToMicros(each.from),
    speed: clip.speed,
    effects,
  };
  const keyframes = document.keyframes(clip.id);
  const field = (path: string) =>
    animated(document, each, keyframes, path, leafOf(clip, path) ?? 0);

  if (each.video) {
    return Object.assign(layer, {
      opacity: field("video.opacity"),
      blend: clip.video?.blend ?? "normal",
      transform: {
        x: field("video.transform.x"),
        y: field("video.transform.y"),
        scaleX: field("video.transform.scaleX"),
        scaleY: field("video.transform.scaleY"),
        rotation: field("video.transform.rotation"),
      },
    });
  }

  return Object.assign(layer, {
    gainDb: field("audio.gainDb"),
    pan: field("audio.pan"),
    fadeIn: flicksToMicros(each.from + (clip.audio?.fadeIn ?? 0)),
    fadeOut: flicksToMicros(each.to - (clip.audio?.fadeOut ?? 0)),
    bus: clip.role,
  });
}
