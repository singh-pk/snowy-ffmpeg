// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Time on a timeline (docs/architecture.md#time): integers in flicks, 705,600,000 per second.
// Every conversion is computed exactly, as a fraction of integers in BigInt, then rounded once,
// halves upwards, so every peer gets the same integer whatever its floating point does.

/** Flicks per second: one frame at every common video rate, and one sample at every common audio rate, is a whole number of them. */
export const FLICKS_PER_SECOND = 705_600_000;

const FLICKS = BigInt(FLICKS_PER_SECOND);

/** A fraction `[numerator, denominator]` of integers, with a positive denominator. */
export type Ratio = [number, number];

function integer(value: number, name: string) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} is not a safe integer: ${value}`);
  return BigInt(value);
}

function positive(value: number, name: string) {
  const big = integer(value, name);
  if (big <= 0n) throw new RangeError(`${name} is not positive: ${value}`);
  return big;
}

// floor(n / d) for d > 0; BigInt division truncates towards zero instead.
function floorDiv(n: bigint, d: bigint) {
  const q = n / d;
  return n % d < 0n ? q - 1n : q;
}

// `flicks` as a number; throws past what a number holds exactly (about 147 days).
function safe(flicks: bigint) {
  if (flicks > BigInt(Number.MAX_SAFE_INTEGER) || flicks < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${flicks} flicks is past what a number holds exactly`);
  }

  return Number(flicks);
}

// n / d rounded to the nearest integer, halves towards +∞: floor((2n + d) / 2d).
function roundHalfUp(n: bigint, d: bigint) {
  return safe(floorDiv(2n * n + d, 2n * d));
}

/**
 * The length of one frame at `rate` frames per second, in flicks. Throws for a rate whose frame
 * isn't a whole number of flicks, which a sequence may not have.
 */
export function frameFlicks([num, den]: Ratio) {
  const n = positive(num, "rate numerator");
  const d = positive(den, "rate denominator");
  if ((FLICKS * d) % n !== 0n)
    throw new RangeError(`a frame at ${num}/${den} fps is not whole flicks`);
  return safe((FLICKS * d) / n);
}

/** `value` units of `timeBase` seconds, in flicks. */
export function toFlicks(value: number, [num, den]: Ratio) {
  return roundHalfUp(
    integer(value, "value") * positive(num, "time base") * FLICKS,
    positive(den, "time base"),
  );
}

/**
 * How far a clip plays to get `delta` units of its stream's `timeBase` at `speed`, in flicks:
 * `delta / speed`, converted once. Negative when the point is before the one it is measured
 * from, or when the clip plays in reverse.
 */
export function sourceToFlicks(delta: number, timeBase: Ratio, [num, den]: Ratio) {
  const speed = integer(num, "speed");
  if (speed === 0n) throw new RangeError("speed is zero");
  const n =
    integer(delta, "delta") * positive(timeBase[0], "time base") * FLICKS * positive(den, "speed");
  const d = positive(timeBase[1], "time base") * speed;
  return d < 0n ? roundHalfUp(-n, -d) : roundHalfUp(n, d);
}

/**
 * How many units of its stream's `timeBase` a clip plays at `speed` in `flicks`: `flicks × speed`,
 * converted once; the inverse of `sourceToFlicks`, up to rounding.
 */
export function flicksToSource(flicks: number, [tbNum, tbDen]: Ratio, [num, den]: Ratio) {
  const n = integer(flicks, "flicks") * integer(num, "speed") * positive(tbDen, "time base");
  return roundHalfUp(n, FLICKS * positive(den, "speed") * positive(tbNum, "time base"));
}

/** `flicks` moved down to the frame boundary at or before it, at `rate`. */
export function snapToFrame(flicks: number, rate: Ratio) {
  const frame = BigInt(frameFlicks(rate));
  return safe(floorDiv(integer(flicks, "flicks"), frame) * frame);
}
