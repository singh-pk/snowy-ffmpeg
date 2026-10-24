// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// How the tests play audio, shared by scripts/gen-fixtures.ts and the test pages: resampled
// to stereo at 44.1 kHz, a rate no fixture has, and compared with native FFmpeg through
// every PROBE_STRIDE-th sample of the first and the last PROBE_SECONDS.

export const PCM_RATE = 44_100;
export const PCM_CHANNELS = 2;
// How often a test play samples the clock: every 32 render quanta, about 93 ms.
export const SAMPLE_FRAMES = 128 * 32;
const PROBE_STRIDE = 509;
const PROBE_SECONDS = 2;

/** The probed samples of interleaved stereo `sample(i)`, of `length` samples in all. */
export function probe(length: number, sample: (i: number) => number) {
  const span = PROBE_SECONDS * PCM_RATE * PCM_CHANNELS;
  const out: number[] = [];
  for (let i = 0; i < Math.min(length, span); i += PROBE_STRIDE) out.push(sample(i));
  for (let i = Math.max(span, length - span); i < length; i += PROBE_STRIDE) out.push(sample(i));
  return out;
}
