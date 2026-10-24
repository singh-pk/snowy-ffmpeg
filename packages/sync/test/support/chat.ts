// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// A chat author for tests: a peer key and its own clock, writing chained messages.

import { messageHash, type ChatMessage } from "../../src/chat";
import { generateKeyPair, keyId } from "../../src/crypto";
import { createClock } from "../../src/hlc";

type Content = Pick<ChatMessage, "kind" | "target" | "text" | "emoji">;

const previousHash = async (last?: ChatMessage) => (last === undefined ? "" : messageHash(last));

export async function createAuthor(now: () => number) {
  const pair = await generateKeyPair();
  const id = await keyId(pair.publicKey);
  const clock = createClock(now);
  const sent: ChatMessage[] = [];

  /** The next message in the author's chain. */
  async function write(content: Content, mediaUs = 0) {
    const prev = await previousHash(sent.at(-1));
    const message: ChatMessage = {
      author: id,
      seq: sent.length + 1,
      prev,
      hlc: clock.send(),
      mediaUs,
      ...content,
    };
    sent.push(message);
    return message;
  }

  return { pair, id, clock, sent, write };
}
