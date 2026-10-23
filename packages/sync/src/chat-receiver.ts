// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Receiving chat (docs/architecture.md#chat). A batch proves itself, so one path takes them all:
// from an author's track, from a repair reply, and this peer's own as it publishes them. Each
// message moves the clock and goes into the log; the batch goes into the holdings, to answer
// others' repairs; and a seq still missing below the newest one held is asked for.

import { decodeBatch } from "./chat-batch";
import type { createChatHoldings } from "./chat-holdings";
import type { createChatLog } from "./chat-log";
import type { createChatRepairs } from "./chat-repairs";
import type { Bytes, KeyId } from "./crypto";
import type { createClock } from "./hlc";

export type ChatReceiverOptions = {
  content: CryptoKey;
  clock: ReturnType<typeof createClock>;
  log: ReturnType<typeof createChatLog>;
  holdings: ReturnType<typeof createChatHoldings>;
  repairs: ReturnType<typeof createChatRepairs>;
  /** Who to ask for an author's missing messages: the author if online, and group peers. */
  candidates(author: KeyId): KeyId[];
};

export function createChatReceiver(options: ChatReceiverOptions) {
  const { log, clock, holdings, repairs } = options;

  async function decoded(key: string, bytes: Bytes, responder?: KeyId) {
    try {
      return await decodeBatch(options.content, key, bytes);
    } catch (error) {
      // A reply that doesn't prove itself answers nothing: ask the next peer.
      if (responder !== undefined) repairs.refused(responder);
      throw error;
    }
  }

  /**
   * Takes a batch object, with the peer that sent it when it answers this peer's repair.
   * Rejects, changing nothing, for one that doesn't decode and prove itself (`decodeBatch`).
   */
  async function receive(key: string, bytes: Bytes, responder?: KeyId) {
    const batch = await decoded(key, bytes, responder);
    const { author } = batch.checkpoint;
    await holdings.add(batch);

    for (const message of batch.messages) {
      const before = clock.value();
      clock.receive(message.hlc);
      log.add(message, before);
    }

    const contiguous = log.versions()[author] ?? 0;
    repairs.filled(author, contiguous);
    if (responder !== undefined) repairs.answered(responder, author, contiguous);

    if (holdings.newest(author) > contiguous) {
      await repairs.gap(author, contiguous + 1, options.candidates(author));
    }
  }

  return { receive };
}
