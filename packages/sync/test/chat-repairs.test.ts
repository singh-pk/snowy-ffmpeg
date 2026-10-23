// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Ranking peers (src/rank.ts) and asking for missing chat (src/chat-repairs.ts), in Bun: every
// asker ranks alike, different questions spread over peers, and an ask moves to the next
// candidate on `gone`, a reply that falls short or fails, or a closed link, stops when filled,
// and gives up when nobody is left until the candidates change or one reconnects.
// Usage: bun test test/chat-repairs.test.ts

import { expect, test } from "bun:test";
import { createChatRepairs } from "../src/chat-repairs";
import { generateKeyPair, keyId } from "../src/crypto";
import { rank } from "../src/rank";

async function newId() {
  const pair = await generateKeyPair();
  return keyId(pair.publicKey);
}

const author = await newId();
const peers = await Promise.all(Array.from({ length: 5 }, newId));

function repairs() {
  const asked: Array<[string, string, number]> = [];
  const r = createChatRepairs((peer, a, seq) => asked.push([peer, a, seq]));
  return { r, asked };
}

test("every asker ranks the same candidates the same way, whatever order it has them in", async () => {
  const one = await rank(peers, author, 7);
  const other = await rank(peers.toReversed(), author, 7);
  expect(other).toEqual(one);
  expect(one.toSorted()).toEqual(peers.toSorted());
});

test("different questions rank the candidates differently", async () => {
  const rankings = await Promise.all(
    Array.from({ length: 8 }, (_, seq) => rank(peers, author, seq + 1)),
  );
  const firsts = new Set(rankings.map((r) => r[0]));
  expect(firsts.size).toBeGreaterThan(1);
});

test("an ask goes to the best-ranked candidate, then the next on gone, a bad reply or a closed link", async () => {
  const { r, asked } = repairs();
  const ranked = await rank(peers, author, 4);
  await r.gap(author, 4, peers);
  expect(asked).toEqual([[ranked[0]!, author, 4]]);

  r.gone(ranked[0]!, author, 4);
  r.refused(ranked[1]!);
  r.closed(ranked[2]!);
  // Answers from peers no longer asked change nothing.
  r.gone(ranked[0]!, author, 4);
  r.closed(ranked[0]!);
  expect(asked.map(([peer]) => peer)).toEqual(ranked.slice(0, 4));
});

test("an ask ends when its gap fills, and gives up when nobody is left", async () => {
  const { r, asked } = repairs();
  const two = peers.slice(0, 2);
  const ranked = await rank(two, author, 4);
  await r.gap(author, 4, two);
  r.filled(author, 6);
  r.gone(ranked[0]!, author, 4);
  expect(asked).toHaveLength(1);

  // A gap the filled seqs reach asks nobody.
  await r.gap(author, 5, two);
  expect(asked).toHaveLength(1);

  const next = await rank(two, author, 7);
  await r.gap(author, 7, two);
  r.gone(next[0]!, author, 7);
  r.gone(next[1]!, author, 7);
  expect(asked).toHaveLength(3);

  // Given up: the same gap with the same candidates asks nobody, but a new candidate asks again.
  await r.gap(author, 7, two.toReversed());
  expect(asked).toHaveLength(3);
  const three = peers.slice(0, 3);
  const reranked = await rank(three, author, 7);
  await r.gap(author, 7, three);
  expect(asked.at(-1)).toEqual([reranked[0]!, author, 7]);
});

test("a gap that ran out of candidates through a closed link is asked again", async () => {
  const { r, asked } = repairs();
  const carol = peers[0]!;
  await r.gap(author, 2, [carol]);
  r.closed(carol);
  await r.gap(author, 2, [carol]);
  expect(asked).toEqual([
    [carol, author, 2],
    [carol, author, 2],
  ]);

  // Carol fails it, so it isn't asked again until her link closes and she comes back.
  r.gone(carol, author, 2);
  await r.gap(author, 2, [carol]);
  expect(asked).toHaveLength(2);
  r.closed(carol);
  await r.gap(author, 2, [carol]);
  expect(asked).toHaveLength(3);
});

test("a gap filled while it was ranked asks nothing, and the gap after it is asked", async () => {
  const { r, asked } = repairs();
  const stale = r.gap(author, 3, peers);
  r.filled(author, 7);
  await Promise.all([stale, r.gap(author, 8, peers)]);
  expect(asked.map(([, , seq]) => seq)).toEqual([8]);
});

test("a reply that falls short of the gap counts as gone from that peer", async () => {
  const { r, asked } = repairs();
  const ranked = await rank(peers, author, 4);
  await r.gap(author, 4, peers);
  r.answered(ranked[1]!, author, 3);
  expect(asked).toHaveLength(1);
  r.answered(ranked[0]!, author, 3);
  expect(asked.map(([peer]) => peer)).toEqual(ranked.slice(0, 2));
});

test("an ask already covering a gap isn't repeated, and an earlier gap replaces it", async () => {
  const { r, asked } = repairs();
  await r.gap(author, 4, peers);
  await r.gap(author, 6, peers);
  expect(asked.map(([, , seq]) => seq)).toEqual([4]);
  await r.gap(author, 2, peers);
  expect(asked.map(([, , seq]) => seq)).toEqual([4, 2]);
});
