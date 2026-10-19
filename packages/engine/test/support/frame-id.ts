// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The frame number burned into every test video (scripts/gen-fixtures.ts): a row of
// FRAME_ID_BITS squares of CELL × CELL pixels in the top-left corner, white for a 1 and black
// for a 0, least significant bit first. Squares this size survive every lossy codec and colour
// conversion in the fixtures, so a test can tell which frame is on screen from its pixels alone.

export const CELL = 16;
export const FRAME_ID_BITS = 16;

/**
 * The frame number in `pixels`, rows `stride` bytes apart, `channels` bytes per pixel with
 * brightness in the first (a grey plane, or the red channel of RGBA).
 */
export function readFrameId(pixels: Uint8Array | Uint8ClampedArray, stride: number, channels = 1) {
  const row = (CELL >> 1) * stride;
  let id = 0;

  for (let bit = 0; bit < FRAME_ID_BITS; bit++) {
    const x = bit * CELL + (CELL >> 1);
    if ((pixels[row + x * channels] ?? 0) > 127) id |= 1 << bit;
  }

  return id;
}
