// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Where connected items go (docs/architecture.md#layout): the time an anchor gives, and the lane
// each item of a role takes. Both are worked out from anchors and durations, the same way on
// every peer, and never stored.

import type { ItemId } from "./ids";
import { snapToFrame, sourceToFlicks, type Ratio } from "./time";

/** What layout needs of the storyline clip a connected item is anchored to. */
export type AnchorClip = {
  /** Where the clip starts on the timeline, in flicks. */
  start: number;
  /** Its in-point, in `timeBase` units. */
  in: number;
  speed: Ratio;
  /** Its stream's time base; `[1, FLICKS_PER_SECOND]` for a generator or a sequence. */
  timeBase: Ratio;
};

// `value`, if it is a time in flicks a number holds exactly.
function flicks(value: number) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not a time in flicks: ${value}`);
  return value;
}

/**
 * Where an item connected to `clip` at source point `at` starts, in flicks: the clip's start
 * plus `(at − in) / speed`. At a negative speed, `in` is still the source point at the clip's
 * start, and playback runs down from it. The point may lie outside the clip, which puts the item
 * before or after it. A video item passes its sequence's `rate` and is snapped down to a frame.
 */
export function clipAnchorStart(clip: AnchorClip, at: number, rate?: Ratio) {
  const start = flicks(clip.start + sourceToFlicks(at - clip.in, clip.timeBase, clip.speed));
  return rate === undefined ? start : snapToFrame(start, rate);
}

/** Where an item connected to a sequence's start at `at` flicks starts; video snaps to a frame. */
export function originAnchorStart(at: number, rate?: Ratio) {
  return rate === undefined ? flicks(at) : snapToFrame(at, rate);
}

/** A connected item of one role, placed in time, with the lane it prefers. */
export type Connected = { id: ItemId; start: number; duration: number; lane: number };

// Order by start, then id by UTF-16 code unit.
function byStartThenId(a: Connected, b: Connected) {
  if (a.start !== b.start) return a.start - b.start;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The lane of each of one role's connected items. Taking them by start, then id, each goes in
 * the lane it prefers if that lane is free over its whole range, and otherwise in the nearest
 * free lane above. Items earlier in that order all start at or before an item, so a lane is free
 * for it when everything already in the lane has ended by its start.
 */
export function assignLanes(items: Connected[]) {
  const ends = new Map<number, number>();
  const lanes = new Map<ItemId, number>();

  for (const item of items.toSorted(byStartThenId)) {
    if (!Number.isSafeInteger(item.lane) || item.lane < 0) {
      throw new RangeError(`not a lane: ${item.lane}`);
    }

    if (!Number.isSafeInteger(item.duration) || item.duration < 0) {
      throw new RangeError(`not a duration: ${item.duration}`);
    }

    flicks(item.start);
    flicks(item.start + item.duration);
    let lane = item.lane;
    while ((ends.get(lane) ?? Number.NEGATIVE_INFINITY) > item.start) lane += 1;
    ends.set(
      lane,
      Math.max(ends.get(lane) ?? Number.NEGATIVE_INFINITY, item.start + item.duration),
    );
    lanes.set(item.id, lane);
  }

  return lanes;
}
