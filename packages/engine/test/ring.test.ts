// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The packet ring between two threads, in Bun: every packet arrives intact and in order
// through a ring far smaller than the data, records wrap around its end, and closing it
// stops a producer that is waiting for room. Usage: bun test test/ring.test.ts

import { expect, test } from "bun:test";
import { createConsumer, createProducer, createRing, END, PRODUCER_WAITING } from "../src/ring";
import { size } from "./support/ring-producer";

function startProducer(ring: SharedArrayBuffer, count: number) {
  const worker = new Worker(new URL("support/ring-producer.ts", import.meta.url));
  const written = new Promise<number>((resolve) => {
    worker.addEventListener("message", (e: MessageEvent<number>) => resolve(e.data), {
      once: true,
    });
  });
  worker.postMessage({ ring, count });
  return { worker, written };
}

test("every packet arrives intact and in order", async () => {
  const count = 5000;
  const ring = createRing(4096);
  const consumer = createConsumer(ring);
  const { worker, written } = startProducer(ring, count);
  const wrong: string[] = [];
  let i = 0;

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream === END) break;
    const { data } = packet;
    const n = size(i);
    const intact = data.length === n && data.every((b, j) => b === ((i + j) & 255));
    const meta = packet.pts === BigInt(i) && packet.dts === BigInt(-i) && packet.flags === (i & 1);
    if (!intact || !meta || packet.duration !== n) wrong.push(`packet ${i}`);
    consumer.release();
    i++;
  }

  expect(wrong).toEqual([]);
  expect(i).toBe(count);
  const total = await written;
  expect(total).toBe(count);
  worker.terminate();
});

test("closing the ring stops a producer that waits for room, and ends the consumer", async () => {
  const ring = createRing(4096);
  const consumer = createConsumer(ring);
  const { worker, written } = startProducer(ring, 1000);
  // Read nothing, so the producer fills the ring and waits for room.
  const control = new Int32Array(ring);
  while (Atomics.load(control, PRODUCER_WAITING) !== 1) await Bun.sleep(1);
  consumer.close();
  const total = await written;
  expect(total).toBeLessThan(1000);
  // A closed ring holds nothing: a peek finds no packet, release does nothing, wait returns.
  expect(consumer.peek()).toBeUndefined();
  consumer.release();
  await consumer.wait();
  expect(consumer.peek()).toBeUndefined();
  worker.terminate();
});

async function timedOut(ms: number) {
  await Bun.sleep(ms);
  return false;
}

test("closing an empty ring ends the consumer's own wait for a packet", async () => {
  const ring = createRing(4096);
  const consumer = createConsumer(ring);
  const waiting = consumer.wait();
  consumer.close();

  async function waited() {
    await waiting;
    return true;
  }

  const ended = await Promise.race([waited(), timedOut(1000)]);
  expect(ended).toBe(true);
});

test("a capacity, packet or duration the ring cannot hold is an error", () => {
  expect(() => createRing(3000)).toThrow(RangeError);
  const producer = createProducer(createRing(64));
  const src = new Uint8Array(64);
  expect(() => producer.write(0, 0, 0n, 0n, 0, src, 0, 64)).toThrow(RangeError);
  expect(() => producer.write(0, 0, 0n, 0n, 2 ** 32 + 5, src, 0, 0)).toThrow(RangeError);
});
