// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Receiving chat (src/chat-receiver.ts), in Bun: two peers end to end. Batches from the
// author's track reach the log and move the clock; a lost batch is noticed and asked for, and a
// repair answered from the holdings of a third peer fills it; a batch that doesn't prove itself
// changes nothing.
// Usage: bun test test/chat-receiver.test.ts

import { expect, test } from "bun:test";
import { sealBatch } from "../src/chat-batch";
import { createChatHoldings } from "../src/chat-holdings";
import { createChatLog } from "../src/chat-log";
import { createChatReceiver } from "../src/chat-receiver";
import { createChatRepairs } from "../src/chat-repairs";
import { createChatSender } from "../src/chat-sender";
import { contentKey, generateKeyPair, keyId, type Bytes } from "../src/crypto";
import { createClock } from "../src/hlc";
import { rejection } from "./support/rejection";

const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");

// A peer, known to others as `id`, with everything chat needs, asking `helpers` for repairs.
function peerState(id: string, helpers: () => string[]) {
  const clock = createClock(() => 1000);
  const log = createChatLog();
  const holdings = createChatHoldings();
  const asked: Array<[string, string, number]> = [];
  const repairs = createChatRepairs((peer, from, seq) => asked.push([peer, from, seq]));
  const receiver = createChatReceiver({
    content,
    clock,
    log,
    holdings,
    repairs,
    candidates: helpers,
  });
  return { id, clock, log, holdings, asked, receiver };
}

// An author whose published batches are kept in order, as its track would carry them.
async function author() {
  const peer = await generateKeyPair();
  const id = await keyId(peer.publicKey);
  const published: Array<{ key: string; bytes: Bytes }> = [];
  const sender = createChatSender({
    peer,
    content,
    clock: createClock(() => 5000),
    publish: (key, bytes) => published.push({ key, bytes }),
  });

  // Writes each text and sends it as its own batch.
  async function say(...texts: string[]) {
    for (const t of texts) {
      await sender.write({ kind: "text", text: t }, 0);
      await sender.writable();
    }
  }

  return { id, published, say };
}

test("batches from the author's track reach the log and move the clock", async () => {
  const alice = await author();
  const bob = peerState("bob", () => []);
  await alice.say("one", "two");
  for (const { key, bytes } of alice.published) await bob.receiver.receive(key, bytes);
  expect(bob.log.entries().map((e) => e.text)).toEqual(["one", "two"]);
  expect(bob.clock.value() >= "000000001388").toBe(true);
  expect(bob.asked).toEqual([]);
});

test("a lost batch is asked for, and a repair from another peer's holdings fills it", async () => {
  const alice = await author();
  const carol = peerState("carol", () => []);
  const bob = peerState("bob", () => [carol.id]);
  await alice.say("one", "two", "three", "four");

  // Carol got everything; Bob lost the batches holding two and three.
  for (const { key, bytes } of alice.published) await carol.receiver.receive(key, bytes);
  const [one, , , four] = alice.published;
  await bob.receiver.receive(one!.key, one!.bytes);
  await bob.receiver.receive(four!.key, four!.bytes);
  expect(bob.asked).toEqual([[carol.id, alice.id, 2]]);

  const reply = carol.holdings.repair(alice.id, 2)!;
  const { key, bytes } = await sealBatch(content, reply);
  await bob.receiver.receive(key, bytes);
  expect(bob.log.entries().map((e) => e.text)).toEqual(["one", "two", "three", "four"]);
  expect(bob.log.versions()).toEqual({ [alice.id]: 4 });
});

test("a repair that fills part of a gap asks again for the rest", async () => {
  const alice = await author();
  const carol = peerState("carol", () => []);
  const bob = peerState("bob", () => [carol.id]);
  await alice.say("one", "two", "three", "four");

  // Carol holds one and two only; Bob holds one and four.
  const [one, two, , four] = alice.published;
  for (const b of [one!, two!]) await carol.receiver.receive(b.key, b.bytes);
  for (const b of [one!, four!]) await bob.receiver.receive(b.key, b.bytes);

  const reply = carol.holdings.repair(alice.id, 2)!;
  const { key, bytes } = await sealBatch(content, reply);
  await bob.receiver.receive(key, bytes);
  expect(bob.asked.map(([, , seq]) => seq)).toEqual([2, 3]);
});

test("a repair reply that doesn't prove itself, or doesn't reach the gap, asks the next peer", async () => {
  const alice = await author();
  const bob = peerState("bob", () => ["carol", "dave"]);
  await alice.say("one", "two", "three");
  const [one, , three] = alice.published;
  for (const b of [one!, three!]) await bob.receiver.receive(b.key, b.bytes);
  const first = bob.asked[0]![0];
  const second = first === "carol" ? "dave" : "carol";

  const altered = one!.bytes.slice();
  altered[30] = (altered[30] ?? 0) ^ 1;
  await rejection(bob.receiver.receive(one!.key, altered, first));
  expect(bob.asked.map(([peer]) => peer)).toEqual([first, second]);

  // A reply holding only what Bob has: nobody is left to ask.
  await bob.receiver.receive(one!.key, one!.bytes, second);
  expect(bob.asked).toHaveLength(2);
});

test("a batch that doesn't prove itself changes nothing", async () => {
  const alice = await author();
  const bob = peerState("bob", () => []);
  await alice.say("one");
  const { key, bytes } = alice.published[0]!;
  const altered = bytes.slice();
  altered[30] = (altered[30] ?? 0) ^ 1;
  const error = await rejection(bob.receiver.receive(key, altered));
  expect(error).toBeInstanceOf(Error);
  expect(bob.log.entries()).toEqual([]);
  expect(bob.holdings.newest(alice.id)).toBe(0);
});
