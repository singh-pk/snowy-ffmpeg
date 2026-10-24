// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Audio output on the main thread: the AudioWorklet (src/audio.worklet.ts) that plays a PCM
// ring into an AudioContext and keeps the clock.

import { AUDIO_PROCESSOR, type AudioOptions, pcmFormat } from "./pcm";

/**
 * Plays PCM ring `ring` on `context`, from when the context runs, with the worklet module at
 * `worklet` (a page that bundles this file elsewhere passes it).
 */
export async function createAudioOutput(
  context: BaseAudioContext,
  ring: SharedArrayBuffer,
  worklet = new URL("./audio.worklet.js", import.meta.url).href,
) {
  const { channels, rate } = pcmFormat(ring);

  if (rate !== context.sampleRate) {
    throw new RangeError(`a ${rate} Hz PCM ring on a ${context.sampleRate} Hz context`);
  }

  await context.audioWorklet.addModule(worklet);
  const processorOptions: AudioOptions = { ring };
  const node = new AudioWorkletNode(context, AUDIO_PROCESSOR, {
    numberOfInputs: 0,
    outputChannelCount: [channels],
    processorOptions,
  });
  node.connect(context.destination);
  return node;
}
