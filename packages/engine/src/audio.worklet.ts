// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The AudioWorklet: plays the PCM ring (src/pcm.ts) and publishes the clock. It runs on the
// audio rendering thread, so it never blocks and never allocates.

/// <reference types="audioworklet" />

import { AUDIO_PROCESSOR, type AudioOptions, createPcmConsumer } from "./pcm";

registerProcessor(
  AUDIO_PROCESSOR,
  class extends AudioWorkletProcessor {
    readonly #pcm: ReturnType<typeof createPcmConsumer>;

    constructor(options: { processorOptions: AudioOptions }) {
      super();
      this.#pcm = createPcmConsumer(options.processorOptions.ring);
    }

    process(_: Float32Array[][], outputs: Float32Array[][]) {
      const output = outputs[0];
      if (output) this.#pcm.read(output, currentFrame);
      return true;
    }
  },
);
