// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Sending this peer's chat (docs/architecture.md#sending). A message is chained and returned at
// once, for the local log, then queued. Whenever the stream is free, everything queued goes as
// one batch, so batching follows the network's speed rather than a clock; while the stream is
// busy or closed, messages wait in the queue.

import { encodeBatch } from "./chat-batch";
import { checkMessage, messageHash, type ChatMessage } from "./chat";
import { keyId, type Bytes } from "./crypto";
import type { Hlc } from "./hlc";

type Content = Pick<ChatMessage, "kind" | "target" | "text" | "emoji">;

export type ChatSenderOptions = {
  /** This peer's key pair: the author of every message, and the checkpoints' signer. */
  peer: CryptoKeyPair;
  content: CryptoKey;
  clock: { send(): Hlc };
  /** The author's newest message from before a reload, to chain the next one to. */
  last?: ChatMessage | undefined;
  /** Hands a batch to the stream; `writable()` is called once the stream takes more. */
  publish(key: string, bytes: Bytes): void;
};

// Stands in for the clock while a message is checked, so a refused one doesn't move it.
const NO_CLOCK = "0000000000000000";

const previousHash = async (last?: ChatMessage) => (last === undefined ? "" : messageHash(last));

export function createChatSender(options: ChatSenderOptions) {
  const author = keyId(options.peer.publicKey);
  const queue: ChatMessage[] = [];
  const state: {
    last?: ChatMessage | undefined;
    writable: boolean;
    /** Counts the stream's closes, so a seal can tell whether one happened meanwhile. */
    closes: number;
    sealing?: Promise<void> | undefined;
  } = { last: options.last, writable: false, closes: 0 };
  // Writes run one after another: each chains to the one before.
  let written: Promise<unknown> = Promise.resolve();

  /**
   * Writes the next message and queues it. Resolves with the message, to add to the local log
   * and store; it is sent with the next batch. Rejects with an `InvalidMessageError`, taking no
   * seq, for content that doesn't make a well-formed message.
   */
  function write(content: Content, mediaUs: number) {
    const next = chain(written, content, mediaUs);
    written = next;
    return next;
  }

  async function chain(before: Promise<unknown>, content: Content, mediaUs: number) {
    try {
      await before;
    } catch {
      // A refused message before this one took no seq; this one chains past it.
    }

    const prev = await previousHash(state.last);
    const id = await author;
    const fields = { author: id, seq: (state.last?.seq ?? 0) + 1, prev, mediaUs, ...content };
    checkMessage({ ...fields, hlc: NO_CLOCK });

    const message: ChatMessage = { ...fields, hlc: options.clock.send() };
    state.last = message;
    queue.push(message);
    void flush();
    return message;
  }

  // Sends what has queued if the stream is writable; one batch is sealed at a time, and a call
  // made meanwhile waits for it, then looks again.
  async function flush(): Promise<void> {
    if (state.sealing !== undefined) {
      try {
        await state.sealing;
      } catch {
        // The call that started that seal reports its failure.
      }

      return flush();
    }

    if (!state.writable || queue.length === 0) return;

    const sealing = seal(queue.splice(0));
    state.sealing = sealing;

    try {
      await sealing;
    } finally {
      state.sealing = undefined;
    }

    // A seal that put its batch back may have missed a writable event: look again.
    return flush();
  }

  async function seal(messages: ChatMessage[]) {
    const closes = state.closes;
    let sealed: Awaited<ReturnType<typeof encodeBatch>>;

    try {
      sealed = await encodeBatch(options.peer, options.content, messages);
    } catch (error) {
      // Nothing is lost: the messages wait for the next writable event.
      queue.unshift(...messages);
      throw error;
    }

    // The stream closed while the batch was sealed, even if it has reopened: the batch goes
    // again, with whatever queued since, once the stream is writable.
    if (state.closes !== closes || !state.writable) {
      queue.unshift(...messages);
      return;
    }

    state.writable = false;
    options.publish(sealed.key, sealed.bytes);
  }

  /**
   * The stream takes more: the event that sends what has queued. Resolves once the batch is
   * handed over; rejects, keeping the messages queued, if it couldn't be sealed.
   */
  function writable() {
    state.writable = true;
    return flush();
  }

  /** The stream closed: messages queue until it is writable again. */
  function closed() {
    state.writable = false;
    state.closes++;
  }

  return { write, writable, closed };
}
