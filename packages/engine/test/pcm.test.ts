// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The PCM ring and its clock, in Bun, one render quantum at a time as the AudioWorklet reads
// it: samples arrive intact across the ring's end and from a producer thread that blocks for
// room, the clock stops on an underrun and resumes with the audio, and closing the ring stops
// the producer, also while it waits. Usage: bun test test/pcm.test.ts

import { expect, test } from "bun:test";
import { createPcmConsumer, createPcmControl, createPcmProducer, createPcmRing } from "../src/pcm";

const RATE = 1000;
// The control word the producer raises while it waits for room (src/pcm.ts).
const PRODUCER_WAITING = 2;
const QUANTUM = 128;
const quantum = () => [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];

// Stereo frames from `first`: channel 0 holds the frame number, channel 1 its negative.
function frames(first: number, count: number) {
  const out = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    out[2 * i] = first + i;
    out[2 * i + 1] = -(first + i);
  }

  return out;
}

test("frames arrive intact and in order across the end of the ring", () => {
  const ring = createPcmRing(256, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const wrong: number[] = [];
  // 100 frames first, so every later write and read of a quantum crosses the end of the ring.
  producer.write(frames(0, 100), 0, 100);
  consumer.read([new Float32Array(100), new Float32Array(100)], 0);

  for (let k = 0; k < 50; k++) {
    const first = 100 + k * QUANTUM;
    expect(producer.write(frames(first, QUANTUM), 0, QUANTUM)).toBe(true);
    const [left = new Float32Array(), right = new Float32Array()] = quantum();
    consumer.read([left, right], 0);

    for (let i = 0; i < QUANTUM; i++) {
      if (left[i] !== first + i || right[i] !== -(first + i)) wrong.push(k);
    }
  }

  expect(wrong).toEqual([]);
});

function startProducer(ring: SharedArrayBuffer, count: number) {
  const worker = new Worker(new URL("support/pcm-producer.ts", import.meta.url));
  const written = new Promise<number>((resolve) => {
    worker.addEventListener("message", (e: MessageEvent<number>) => resolve(e.data), {
      once: true,
    });
  });
  worker.postMessage({ ring, count });
  return { worker, written };
}

test("frames arrive intact from a producer thread that waits for room", async () => {
  const count = 20_000;
  const ring = createPcmRing(256, 2, RATE);
  const consumer = createPcmConsumer(ring);
  const { worker, written } = startProducer(ring, count);
  const output = quantum();
  const wrong: number[] = [];
  let next = 0;

  while (next < count) {
    consumer.read(output, 0);
    const [left = new Float32Array(), right = new Float32Array()] = output;
    // A short read leaves silence after the last frame, and no frame is silent.
    let n = 0;
    while (n < QUANTUM && left[n] !== 0) n++;

    for (let i = 0; i < n; i++) {
      if (left[i] !== next + i + 1 || right[i] !== -(next + i + 1)) wrong.push(next + i);
    }

    next += n;
    if (n < QUANTUM) await Bun.sleep(0);
  }

  expect(wrong).toEqual([]);
  const total = await written;
  expect(total).toBe(count);
  worker.terminate();
});

test("closing the ring stops a producer that waits for room", async () => {
  const ring = createPcmRing(256, 2, RATE);
  const { worker, written } = startProducer(ring, 10_000);
  const control = new Int32Array(ring);
  while (Atomics.load(control, PRODUCER_WAITING) !== 1) await Bun.sleep(1);
  createPcmControl(ring).close();
  const total = await written;
  expect(total).toBeLessThan(10_000);
  worker.terminate();
});

test("the clock stops on an underrun and resumes with the audio", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  producer.start(10);
  producer.write(frames(0, 250), 0, 250);
  const output = quantum();

  // A full quantum: the clock runs, at the media time of the next frame.
  consumer.read(output, 0);
  expect(control.read()).toEqual({ pts: 10.128, time: 0.128, playing: true });
  expect(control.mediaTime(0.2)).toBeCloseTo(10.2, 12);

  // 122 frames, then silence: the clock stops after the last frame, at its context time, and
  // runs until then.
  consumer.read(output, 128);
  expect(control.read()).toEqual({ pts: 10.25, time: 0.25, playing: false });
  expect(output[0]?.[121]).toBe(249);
  expect(output[0]?.subarray(122).every((v) => v === 0)).toBe(true);
  expect(control.mediaTime(0.2)).toBeCloseTo(10.2, 12);
  expect(control.mediaTime(5)).toBe(10.25);

  // An empty ring: still stopped where the last frame played, and silent.
  consumer.read(output, 256);
  expect(control.read()).toEqual({ pts: 10.25, time: 0.25, playing: false });
  expect(output[1]?.every((v) => v === 0)).toBe(true);

  // The audio continues: so does the clock, from where it stopped.
  producer.write(frames(250, 250), 0, 250);
  consumer.read(output, 384);
  expect(control.read()).toEqual({ pts: 10.378, time: 0.512, playing: true });
  expect(output[0]?.[0]).toBe(250);
});

test("closing the ring stops the producer and silences the consumer", () => {
  const ring = createPcmRing(256, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  producer.write(frames(0, 100), 0, 100);
  createPcmControl(ring).close();
  expect(producer.write(frames(100, 1), 0, 1)).toBe(false);
  const output = quantum();
  consumer.read(output, 0);
  expect(output[0]?.every((v) => v === 0)).toBe(true);
});

test("a ring size that is not a power of two is an error", () => {
  expect(() => createPcmRing(1000, 2, RATE)).toThrow(RangeError);
});

test("what is heard comes from the output timestamp, carried forward while it runs", () => {
  const ring = createPcmRing(1024, 2, RATE);
  const producer = createPcmProducer(ring);
  const consumer = createPcmConsumer(ring);
  const control = createPcmControl(ring);
  producer.start(10);
  producer.write(frames(0, 1000), 0, 1000);
  // Rendered up to context time 0.128, which plays media time 10.128.
  consumer.read(quantum(), 0);

  // Context time 0.1 heard at 5000 ms: 50 ms later, 0.15 is heard, so media time 10.15.
  control.publishOutput(0.1, 5000, true);
  expect(control.heard(5050)).toBeCloseTo(10.15, 12);
  // Suspended: what is heard stays where the output stopped.
  control.publishOutput(0.1, 5000, false);
  expect(control.heard(9000)).toBeCloseTo(10.1, 12);
});
