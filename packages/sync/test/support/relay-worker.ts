// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The relay tests' side in Chromium (test/relay.test.ts), in a dedicated worker, where the chat
// store's OPFS sync access handles work. Each scenario runs peers against the relay and posts
// back what they saw; the test asserts on it. Waiting is on events: each peer's `until` resolves
// once a check holds after something it watches has changed.

import { openChat } from "../../src/chat-session";
import { contentKey, generateKeyPair, keyId, type Bytes, type KeyId } from "../../src/crypto";
import type { Link } from "../../src/link";
import { connectRelay, frame, RelayRequestError, unframe } from "../../src/relay";

export type RelayConfig = { url: string; hash: string };
export type Scenario = keyof typeof scenarios;

type Relay = Awaited<ReturnType<typeof connectRelay>>;

const randomId = () =>
  crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });

// Checks that resolve once they hold, looked at again on each `changed()`.
function watch() {
  const waiting: Array<{ check: () => boolean; resolve: () => void }> = [];

  function changed() {
    for (const wait of waiting.filter((w) => w.check())) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve();
    }
  }

  async function until(check: () => boolean) {
    if (check()) return;

    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.push({ check, resolve });
    await promise;
  }

  return { changed, until };
}

async function peer(
  config: RelayConfig,
  session: KeyId,
  tracks: string[] = [],
  known: Promise<CryptoKeyPair> = generateKeyPair(),
) {
  const pair = await known;
  const id = await keyId(pair.publicKey);
  const relay = await connectRelay({
    url: config.url,
    serverCertificateHashes: [{ algorithm: "sha-256", value: Uint8Array.fromBase64(config.hash) }],
    session,
    self: id,
    tracks,
  });
  return { pair, id, relay, ...watch() };
}

// Presence: each peer sees the other come online, and go when it leaves.
async function presence(config: RelayConfig) {
  const session = randomId();
  const alice = await peer(config, session);
  const seen: string[] = [];
  alice.relay.on("announce", () => void seen.push("announce"));
  alice.relay.on("unannounce", () => void seen.push("unannounce"));
  alice.relay.on("announce", alice.changed);
  alice.relay.on("unannounce", alice.changed);
  alice.relay.listen();

  const bob = await peer(config, session);
  const bobSaw: KeyId[] = [];

  bob.relay.on("announce", (other) => {
    bobSaw.push(other);
    bob.changed();
  });

  bob.relay.listen();
  await Promise.all([alice.until(() => seen.length === 1), bob.until(() => bobSaw.length === 1)]);
  await bob.relay.close();
  await alice.until(() => seen.length === 2);
  await alice.relay.close();
  return { aliceSaw: seen, bobSawAlice: bobSaw[0] === alice.id };
}

// Links: one opens between two online peers, carries a message each way and an object, and
// closes when one of them leaves.
async function links(config: RelayConfig) {
  const session = randomId();
  const [alice, bob] = await Promise.all([peer(config, session), peer(config, session)]);
  const heard: unknown[] = [];
  const objects: Array<{ key: string; text: string }> = [];
  const opened: Record<string, Link> = {};
  const closed: string[] = [];

  for (const [name, member] of [
    ["alice", alice],
    ["bob", bob],
  ] as const) {
    member.relay.on("link", (link) => {
      opened[name] = link;
      link.on("message", (value) => void heard.push({ to: name, value }));
      link.on(
        "object",
        (key, bytes) => void objects.push({ key, text: new TextDecoder().decode(bytes) }),
      );
      link.on("close", () => void closed.push(name));
      for (const event of ["message", "object", "close"] as const) link.on(event, member.changed);
      member.changed();
    });
  }

  alice.relay.listen();
  bob.relay.listen();
  await Promise.all([alice.until(() => "alice" in opened), bob.until(() => "bob" in opened)]);
  opened.alice!.send({ type: "chat-gone", author: alice.id, firstSeq: 1 });
  opened.bob!.send({ type: "chat-gone", author: bob.id, firstSeq: 2 });
  opened.bob!.deliver(`chat/${bob.id}/1-1`, new TextEncoder().encode("batch"));
  await Promise.all([alice.until(() => objects.length === 1), bob.until(() => heard.length > 0)]);
  await alice.until(() => heard.length === 2);

  await bob.relay.close();
  await alice.until(() => closed.includes("alice"));
  await alice.relay.close();
  return {
    heard,
    objects,
    fromBob: objects.map((o) => o.key === `chat/${bob.id}/1-1`),
    // In no particular order: Bob's link closes with its connection, Alice's as Bob is withdrawn.
    closed: closed.toSorted(),
    peers: { alice: opened.bob!.peer === alice.id, bob: opened.alice!.peer === bob.id },
  };
}

// Rejoining: a peer that leaves and comes back with the same key opens a new link with a peer
// that stayed, which carries messages as the first did.
async function rejoin(config: RelayConfig) {
  const session = randomId();
  const alice = await peer(config, session);
  const seen: Link[] = [];
  const heard: unknown[] = [];
  const closed = { count: 0 };

  alice.relay.on("link", (link) => {
    seen.push(link);
    link.on("message", (value) => void heard.push(value));
    link.on("message", alice.changed);
    link.on("close", () => void closed.count++);
    link.on("close", alice.changed);
    alice.changed();
  });

  alice.relay.listen();
  const first = await peer(config, session);
  first.relay.listen();
  await alice.until(() => seen.length === 1);
  await first.relay.close();
  await alice.until(() => closed.count === 1);

  const again = await peer(config, session, [], Promise.resolve(first.pair));
  const fromAlice: unknown[] = [];

  again.relay.on("link", (link) => {
    link.on("message", (value) => void fromAlice.push(value));
    link.on("message", again.changed);
    link.send({ type: "chat-gone", author: again.id, firstSeq: 3 });
  });

  again.relay.listen();
  await alice.until(() => seen.length === 2);
  seen[1]!.send({ type: "chat-gone", author: alice.id, firstSeq: 4 });
  await Promise.all([
    alice.until(() => heard.length === 1),
    again.until(() => fromAlice.length === 1),
  ]);
  await Promise.all([alice.relay.close(), again.relay.close()]);
  return { samePeer: seen[1]!.peer === first.id, heard, fromAlice };
}

// A peer's chat over the relay: its track carries what it writes, and its links repairs.
async function chatter(config: RelayConfig, session: KeyId, content: CryptoKey) {
  const member = await peer(config, session, ["chat"]);
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`relay-${crypto.randomUUID()}`, { create: true });
  const track = member.relay.track("chat");
  const chat = await openChat({
    peer: member.pair,
    content,
    session: dir,
    publish: (key, bytes) => track.send(frame(key, bytes)),
    onChange: member.changed,
  });
  const ready = { links: 0, subscriptions: 0 };

  async function received(payload: Bytes) {
    const object = unframe(payload);
    if (object !== undefined) await chat.received(object.key, object.bytes);
  }

  async function subscribe(relay: Relay, other: KeyId) {
    await relay.subscribe(other, "chat", received);
    ready.subscriptions++;
    member.changed();
  }

  member.relay.on("announce", (other) => void subscribe(member.relay, other));

  member.relay.on("link", (link) => {
    chat.connect(link);
    ready.links++;
    member.changed();
  });

  member.relay.listen();

  async function say(text: string) {
    await chat.write({ kind: "text", text }, 0);
    await chat.writable();
  }

  const texts = () => chat.entries().map((e) => e.text);
  return { ...member, chat, ready, say, texts };
}

// Chat: what one peer writes reaches the others through its track, and a peer that joins late
// catches up through a link from one version vector.
async function chatting(config: RelayConfig) {
  const session = randomId();
  const content = await contentKey(crypto.getRandomValues(new Uint8Array(32)), session);
  const [alice, bob] = await Promise.all([
    chatter(config, session, content),
    chatter(config, session, content),
  ]);
  const both = (m: typeof alice) =>
    m.until(() => m.ready.links === 1 && m.ready.subscriptions === 1);
  await Promise.all([both(alice), both(bob)]);

  await alice.say("one");
  await alice.say("two");
  await bob.until(() => bob.texts().length === 2);

  const carol = await chatter(config, session, content);
  await carol.until(() => carol.ready.links === 2 && carol.ready.subscriptions === 2);
  await carol.chat.reconnected();
  await carol.until(() => carol.texts().length === 2);
  await alice.until(() => alice.ready.links === 2 && alice.ready.subscriptions === 2);
  await alice.say("three");
  await Promise.all([carol, bob].map((m) => m.until(() => m.texts().length === 3)));

  const result = { bob: bob.texts(), carol: carol.texts() };
  await Promise.all([alice, bob, carol].map((m) => m.chat.close()));
  await Promise.all([alice, bob, carol].map((m) => m.relay.close()));
  return result;
}

// Refusal: the relay refuses a subscription to a track nobody publishes.
async function refused(config: RelayConfig) {
  const alice = await peer(config, randomId());
  const other = await generateKeyPair();
  const nobody = await keyId(other.publicKey);

  try {
    await alice.relay.subscribe(nobody, "chat", () => undefined);
    return { refused: false };
  } catch (error) {
    return { refused: error instanceof RelayRequestError };
  } finally {
    await alice.relay.close();
  }
}

const scenarios = { presence, links, rejoin, chat: chatting, refused };

async function run({ scenario, config }: { scenario: Scenario; config: RelayConfig }) {
  try {
    const result = await scenarios[scenario](config);
    postMessage({ result });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    });
  }
}

// A rejection nothing handles fails the scenario rather than leaving it waiting.
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const { reason }: { reason: unknown } = event;
  postMessage({
    error: reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason),
  });
});

addEventListener(
  "message",
  ({ data }: MessageEvent<{ scenario: Scenario; config: RelayConfig }>) => {
    void run(data);
  },
);
