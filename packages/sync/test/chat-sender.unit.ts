// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Sending chat (src/chat-sender.ts), in Chromium: messages chain at once and in call order; nothing
// goes until the stream is writable, then everything queued goes as one batch, and what is
// written while the stream is busy or closed, even mid-seal, waits for the next writable event.
// A refused message takes no seq, a batch that fails to seal loses nothing, and a reload chains
// on from the stored last message.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { decodeBatch } from "../src/chat-batch";
import { InvalidMessageError, messageHash, type ChatMessage } from "../src/chat";
import { createChatSender, type ChatSenderOptions } from "../src/chat-sender";
import { contentKey, generateKeyPair, keyId, type Bytes } from "../src/crypto";
import { createClock } from "../src/hlc";
import { rejection } from "./support/rejection";

const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), "session");
const peer = await generateKeyPair();
const author = await keyId(peer.publicKey);

type Batch = { key: string; bytes: Bytes };

// A sender whose stream records what it is handed. `published(n)` waits until the stream has
// been handed n batches, since a write that finds the stream writable seals one in the
// background. `duringSeal` runs once, as the next batch starts to be sealed: sealing reads the
// public key first, and only reads it again for the signature after its first await.
function sender(last?: ChatMessage, pending?: ChatMessage[]) {
  const batches: Batch[] = [];
  const kept: ChatMessage[] = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  const hooks: { duringSeal?: (() => void) | undefined } = {};
  const options: ChatSenderOptions = {
    peer: {
      get publicKey() {
        const hook = hooks.duringSeal;
        hooks.duringSeal = undefined;
        hook?.();
        return peer.publicKey;
      },
      privateKey: peer.privateKey,
    },
    content,
    clock: createClock(() => 1000),
    keep: (message) => kept.push(message),
    last,
    pending,
    publish(key, bytes) {
      batches.push({ key, bytes });
      for (const wait of waiting.filter((w) => batches.length >= w.count)) wait.resolve();
    },
  };
  const chat = createChatSender(options);

  async function published(count: number) {
    if (batches.length < count) {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.push({ count, resolve });
      await promise;
    }

    return batches.map((b) => b.key);
  }

  return { chat, options, hooks, batches, kept, published };
}

const text = (t: string) => ({ kind: "text" as const, text: t });
const key = (first: number, last: number) => `chat/${author}/${first}-${last}`;

async function messagesOf(batches: Batch[]) {
  const decoded = await Promise.all(batches.map((b) => decodeBatch(content, b.key, b.bytes)));
  return decoded.flatMap((b) => b.messages);
}

test("messages chain at once, and nothing is sent before the stream is writable", async () => {
  const { chat, batches } = sender();
  const first = await chat.write(text("one"), 5);
  const second = await chat.write(text("two"), 6);
  const hash = await messageHash(first);
  expect([first.author, first.seq, first.prev, first.mediaUs]).toEqual([author, 1, "", 5]);
  expect([second.seq, second.prev]).toEqual([2, hash]);

  // Had anything gone early, the first batch wouldn't hold both.
  await chat.writable();
  expect(batches.map((b) => b.key)).toEqual([key(1, 2)]);
  const sent = await messagesOf(batches);
  expect(sent).toEqual([first, second]);
});

test("writes made together chain in call order", async () => {
  const { chat } = sender();
  const written = await Promise.all([
    chat.write(text("a"), 0),
    chat.write(text("b"), 0),
    chat.write(text("c"), 0),
  ]);
  const hashes = await Promise.all(written.map((m) => messageHash(m)));
  expect(written.map((m) => [m.seq, m.text])).toEqual([
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);
  expect(written.map((m) => m.prev)).toEqual(["", ...hashes.slice(0, 2)]);
});

test("what is written while the stream is busy waits for the next writable event", async () => {
  const { chat, batches, published } = sender();
  await chat.writable();
  await chat.write(text("one"), 0);
  await published(1);
  await chat.write(text("two"), 0);
  await chat.write(text("three"), 0);

  // Had either gone while busy, there would be a batch between these two.
  await chat.writable();
  expect(batches.map((b) => b.key)).toEqual([key(1, 1), key(2, 3)]);
  const sent = await messagesOf(batches);
  expect(sent.map((m) => m.text)).toEqual(["one", "two", "three"]);
});

test("messages written while the stream is closed go once it is writable again", async () => {
  const { chat, batches } = sender();
  await chat.writable();
  chat.closed();
  await chat.write(text("offline"), 0);
  await chat.writable();
  expect(batches.map((b) => b.key)).toEqual([key(1, 1)]);
});

test("a stream that closes while a batch is sealed sends it again, with what queued since", async () => {
  const { chat, hooks, batches } = sender();
  await chat.writable();
  hooks.duringSeal = () => chat.closed();
  await chat.write(text("one"), 0);
  await chat.write(text("two"), 0);

  // Whether or not the seal in flight has finished, it puts its batch back, and both go.
  await chat.writable();
  expect(batches.map((b) => b.key)).toEqual([key(1, 2)]);
  const sent = await messagesOf(batches);
  expect(sent.map((m) => m.text)).toEqual(["one", "two"]);
});

test("a batch sealed across a close and reopen is sealed again for the new stream", async () => {
  const { chat, hooks, batches, published } = sender();
  await chat.writable();

  hooks.duringSeal = () => {
    chat.closed();
    void chat.writable();
  };

  await chat.write(text("one"), 0);
  await published(1);
  await chat.write(text("two"), 0);
  expect(batches.map((b) => b.key)).toEqual([key(1, 1)]);

  await chat.writable();
  expect(batches.map((b) => b.key)).toEqual([key(1, 1), key(2, 2)]);
});

test("a refused message takes no seq, and the chain runs on past it", async () => {
  const { chat, batches } = sender();
  const first = await chat.write(text("first"), 0);
  const error = await rejection(chat.write({ kind: "edit", text: "no target" }, 0));
  const second = await chat.write(text("second"), 0);
  const hash = await messageHash(first);
  expect(error).toBeInstanceOf(InvalidMessageError);
  expect([second.seq, second.prev]).toEqual([2, hash]);

  await chat.writable();
  const sent = await messagesOf(batches);
  expect(sent).toEqual([first, second]);
});

test("a batch that fails to seal keeps its messages for the next writable event", async () => {
  const { chat, options, batches } = sender();
  options.content = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "decrypt",
  ]);
  const message = await chat.write(text("kept"), 0);
  const error = await rejection(chat.writable());
  expect(error).toBeInstanceOf(Error);
  expect(batches).toEqual([]);

  options.content = content;
  await chat.writable();
  const sent = await messagesOf(batches);
  expect(sent).toEqual([message]);
});

test("a message is stored before it is queued, and one that can't be stored takes no seq", async () => {
  const { chat, options, batches, kept, published } = sender();
  await chat.writable();
  const one = await chat.write(text("one"), 0);
  expect(kept).toEqual([one]);
  await published(1);

  options.keep = () => Promise.reject(new Error("the disk is full"));
  const error = await rejection(chat.write(text("lost"), 0));
  expect(error).toBeInstanceOf(Error);
  options.keep = (message) => kept.push(message);
  const two = await chat.write(text("two"), 0);
  expect(two.seq).toBe(2);
  await chat.writable();
  const sent = await messagesOf(batches);
  expect(sent).toEqual([one, two]);
});

test("messages pending from before a reload go with the first batch", async () => {
  const before = sender();
  const one = await before.chat.write(text("one"), 0);
  const two = await before.chat.write(text("two"), 0);
  const after = sender(two, [one, two]);
  const three = await after.chat.write(text("three"), 0);
  await after.chat.writable();
  const keys = await after.published(1);
  expect(keys).toEqual([key(1, 3)]);
  const sent = await messagesOf(after.batches);
  expect(sent).toEqual([one, two, three]);
});

test("after a reload, the next message chains to the stored last one", async () => {
  const before = sender();
  const last = await before.chat.write(text("before the reload"), 0);
  const after = sender(last);
  const next = await after.chat.write(text("after"), 0);
  const hash = await messageHash(last);
  expect([next.seq, next.prev]).toEqual([2, hash]);
});
