// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render plan (docs/architecture.md#queries-and-the-render-plan): what @snowy-media/engine
// plays and exports for a range of a sequence. The range is cut into segments in which the set of
// layers doesn't change; each layer says how to read its source and how to draw or mix it, with
// every keyframe at its time on the timeline. Times are microseconds from here on, converted from
// flicks once each; source points stay in their stream's units.

import type { ItemRecord, KeyframeRecord, Value } from "./document";
import type { ItemId } from "./ids";
import type { Document } from "./project";
import { leafOf } from "./project";
import { FLICKS_PER_SECOND, flicksToMicros, sourceToFlicks, type Ratio } from "./time";

type Clip = Extract<ItemRecord, { kind: "clip" }>;

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
  blend: string;
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

/** A part of the range in which the same layers play: video bottom to top, and audio. */
type Segment = { from: number; to: number; video: VideoLayer[]; audio: AudioLayer[] };

/** The plan of a range: its segments, and the sources whose layers start where it ends. */
type Plan = { sequence: ItemId; segments: Segment[]; next: Layer["source"][] };

// A clip as placed, with what orders it among the others: the storyline first, then each role in
// order, then each lane from the lowest up.
type Placed = { clip: Clip & { id: ItemId }; from: number; to: number; order: number[] };

const byOrder = (a: Placed, b: Placed) => {
  for (const [i, value] of a.order.entries()) {
    const other = b.order[i] ?? 0;
    if (value !== other) return value - other;
  }

  return 0;
};

/**
 * The render plan of `sequence` from `from` to `to`, in flicks, or undefined for a sequence the
 * document doesn't have. Disabled clips, gaps and markers play nothing.
 */
export function plan(document: Document, sequence: ItemId, from: number, to: number) {
  if (document.sequence(sequence) === undefined) return undefined;
  const placed = placedClips(document, sequence);
  const cuts = new Set([from, to]);

  for (const each of placed) {
    if (each.from > from && each.from < to) cuts.add(each.from);
    if (each.to > from && each.to < to) cuts.add(each.to);
  }

  const bounds = [...cuts].toSorted((a, b) => a - b);
  const segments: Segment[] = [];

  for (const [i, start] of bounds.slice(0, -1).entries()) {
    const end = bounds[i + 1] ?? to;
    const playing = placed.filter((each) => each.from <= start && each.to >= end);
    segments.push({
      from: flicksToMicros(start),
      to: flicksToMicros(end),
      video: playing.filter((each) => isVideo(document, each)).map((each) => video(document, each)),
      audio: playing
        .filter((each) => !isVideo(document, each))
        .map((each) => audio(document, each)),
    });
  }

  const next = placed
    .filter((each) => each.from === to)
    .map((each) => layer(document, each).source);
  return { sequence, segments, next } satisfies Plan;
}

const isVideo = (document: Document, { clip }: Placed) =>
  document.role(clip.role)?.kind === "video";

// Every enabled clip of a sequence with its place, in compositing order.
function placedClips(document: Document, sequence: ItemId) {
  const placed: Placed[] = [];

  for (const { id, start, duration } of document.storyline(sequence)) {
    const clip = document.item(id);
    if (clip?.kind !== "clip" || !clip.enabled) continue;
    placed.push({ clip, from: start, to: start + duration, order: [0] });
  }

  for (const [index, role] of document.roles(sequence).entries()) {
    for (const [id, lane] of document.lanes(role.id)) {
      const clip = document.item(id);
      const start = document.start(id);
      if (clip?.kind !== "clip" || !clip.enabled || start === undefined) continue;
      placed.push({ clip, from: start, to: start + clip.duration, order: [1, index, lane] });
    }
  }

  return placed.toSorted(byOrder);
}

function timeBaseOf(document: Document, clip: Clip): Ratio {
  const { source } = clip;
  if (!("asset" in source)) return [1, FLICKS_PER_SECOND];
  const stream = document.asset(source.asset)?.streams.find((each) => each.index === source.stream);
  return stream?.timeBase ?? [1, FLICKS_PER_SECOND];
}

// A parameter of `target` at `param`: its keyframes on the timeline if it has any, else `value`.
function animated(
  document: Document,
  { clip, from }: Placed,
  target: ItemId,
  param: string,
  value: Value,
): Animated {
  const keyframes = document.keyframes(target).filter((each) => each.param === param);
  if (keyframes.length === 0) return value;
  const timeBase = timeBaseOf(document, clip);
  return {
    keyframes: keyframes.map(({ at, value: then, ease }) => ({
      at: flicksToMicros(from + sourceToFlicks(at - clip.in, timeBase, clip.speed)),
      value: then,
      ease,
    })),
  };
}

function params(each: Placed, document: Document, target: ItemId, values: Record<string, Value>) {
  const found: Record<string, Animated> = {};
  for (const [name, value] of Object.entries(values))
    found[name] = animated(document, each, target, name, value);
  return found;
}

function layer(document: Document, each: Placed): Layer {
  const { clip } = each;
  const { source } = clip;
  const effects = document
    .effects(clip.id)
    .filter((effect) => effect.enabled)
    .map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      params: params(each, document, effect.id, effect.params),
    }));
  const planned: Layer["source"] =
    "generator" in source
      ? {
          generator: source.generator,
          params: Object.fromEntries(
            Object.entries(source.params).map(([name, value]) => [
              name,
              animated(document, each, clip.id, `source.params.${name}`, value),
            ]),
          ),
        }
      : source;
  return {
    clip: clip.id,
    source: planned,
    in: clip.in,
    timeBase: timeBaseOf(document, clip),
    start: flicksToMicros(each.from),
    speed: clip.speed,
    effects,
  };
}

// A leaf of a clip's own fields, animated by its keyframes.
function field(document: Document, each: Placed, path: string) {
  return animated(document, each, each.clip.id, path, leafOf(each.clip, path) ?? 0);
}

function video(document: Document, each: Placed): VideoLayer {
  const leaf = (path: string) => field(document, each, `video.${path}`);
  return Object.assign(layer(document, each), {
    opacity: leaf("opacity"),
    blend: String(leafOf(each.clip, "video.blend")),
    transform: {
      x: leaf("transform.x"),
      y: leaf("transform.y"),
      scaleX: leaf("transform.scaleX"),
      scaleY: leaf("transform.scaleY"),
      rotation: leaf("transform.rotation"),
    },
  });
}

function audio(document: Document, each: Placed): AudioLayer {
  const fade = (path: string) => Number(leafOf(each.clip, path));
  return Object.assign(layer(document, each), {
    gainDb: field(document, each, "audio.gainDb"),
    pan: field(document, each, "audio.pan"),
    fadeIn: flicksToMicros(each.from + fade("audio.fadeIn")),
    fadeOut: flicksToMicros(each.to - fade("audio.fadeOut")),
    bus: each.clip.role,
  });
}
