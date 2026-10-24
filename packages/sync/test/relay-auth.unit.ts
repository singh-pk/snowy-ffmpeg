// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Relay authorization (src/relay-auth.ts), in Chromium: a peer's token admits it to its own
// namespaces in its own session, the source's to `source` too, and anything forged, stale,
// misplaced or malformed admits nothing; the auth server answers moq-relay's requests to match,
// and asks the app's `admit` only about connections whose token checked out.
// Usage: bun run test

import { expect, test } from "../../../tooling/unit";
import { generateKeyPair, keyId, sign } from "../src/crypto";
import {
  authorize,
  authServer,
  createAuthServer,
  type Connection,
  joinGrant,
  peerToken,
  sourceToken,
  TOKEN_AGE,
  TOKEN_SKEW,
  type JoinGrant,
} from "../src/relay-auth";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function setup() {
  const session = await generateKeyPair();
  const peer = await generateKeyPair();
  const [sessionId, peerId, grant] = await Promise.all([
    keyId(session.publicKey),
    keyId(peer.publicKey),
    joinGrant(session),
  ]);
  return { session, peer, sessionId, peerId, grant, path: `/snowy/${sessionId}` };
}

const query = (token: string) => `token=${token}`;

const relayPost = (body: unknown) =>
  new Request("http://auth/", { method: "POST", body: JSON.stringify(body) });

const post = (body: unknown) => authServer(relayPost(body));

type TokenJson = {
  kind: string;
  grant: { rights: string; sig: string };
  request: { peer: string; session: string; issuedAt: unknown };
  sig: string;
  sessionSig?: string;
};

const base64 = (bytes: Uint8Array<ArrayBuffer>) =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true });

const tokenJson = (token: string): TokenJson =>
  JSON.parse(decoder.decode(Uint8Array.fromBase64(token, { alphabet: "base64url" })));

// When a token was made, by its request.
const issued = (token: string) => Number(tokenJson(token).request.issuedAt);

// A peer's token made at `issuedAt`, signed as the docs give it.
async function tokenAt(grant: JoinGrant, peer: CryptoKeyPair, issuedAt: number) {
  const id = await keyId(peer.publicKey);
  const request = { peer: id, session: grant.session, issuedAt };
  const sig = await sign(
    peer.privateKey,
    encoder.encode(`snowy relay v1\n${JSON.stringify(request)}`),
  );
  return base64(encoder.encode(JSON.stringify({ kind: "peer", grant, request, sig: base64(sig) })));
}

// A token with one field of its JSON changed.
function altered(token: string, change: (json: TokenJson) => void) {
  const json = tokenJson(token);
  change(json);
  return encoder
    .encode(JSON.stringify(json))
    .toBase64({ alphabet: "base64url", omitPadding: true });
}

test("a peer's token admits it to its own broadcasts and inboxes, and to the others' to read", async () => {
  const { peer, peerId, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const granted = await authorize(path, query(token), Date.now());
  expect(granted).toEqual({
    publish: [`peer/${peerId}`, `inbox/*/${peerId}`],
    subscribe: ["source", "peer/*", `inbox/${peerId}/*`],
  });
});

test("the source's token admits it to `source` too, and to everything to read", async () => {
  const { session, peer, peerId, path } = await setup();
  const token = await sourceToken(session, peer);
  const granted = await authorize(path, query(token), Date.now());
  expect(granted).toEqual({
    publish: ["source", `peer/${peerId}`, `inbox/*/${peerId}`],
    subscribe: ["**"],
  });
});

test("a token admits only at its session's path, under any prefix the relay URL has", async () => {
  const { peer, grant, path } = await setup();
  const other = await setup();
  const token = await peerToken(grant, peer);
  const now = Date.now();
  const [prefixed, elsewhere, root, bare] = await Promise.all([
    authorize(`/relay${path}`, query(token), now),
    authorize(other.path, query(token), now),
    authorize("/", query(token), now),
    authorize(path.slice("/snowy".length), query(token), now),
  ]);
  expect(prefixed === undefined).toBe(false);
  expect([elsewhere, root, bare]).toEqual([undefined, undefined, undefined]);
});

test("a token admits a new connection only while it is fresh", async () => {
  const { peer, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const issuedAt = issued(token);
  const [stale, early, last, first, admitted] = await Promise.all([
    authorize(path, query(token), issuedAt + TOKEN_AGE + 1),
    authorize(path, query(token), issuedAt - TOKEN_SKEW - 1),
    authorize(path, query(token), issuedAt + TOKEN_AGE),
    authorize(path, query(token), issuedAt - TOKEN_SKEW),
    authorize(path, query(token), issuedAt + TOKEN_AGE + 1, false),
  ]);
  expect([stale, early]).toEqual([undefined, undefined]);
  expect([last, first, admitted].map((g) => g === undefined)).toEqual([false, false, false]);
});

test("a grant or a token signed by any other key admits nothing", async () => {
  const { peer, grant, path, sessionId } = await setup();
  const other = await setup();
  const now = Date.now();
  const [byOtherSession, own, otherSource] = await Promise.all([
    peerToken({ ...other.grant, session: sessionId }, peer),
    peerToken(grant, peer),
    sourceToken(other.session, peer),
  ]);
  const asOtherPeer = altered(own, (json) => (json.request.peer = other.peerId));
  const peerAsSource = altered(otherSource, (json) => (json.request.session = sessionId));
  const results = await Promise.all(
    [byOtherSession, asOtherPeer, peerAsSource].map((t) => authorize(path, query(t), now)),
  );
  expect(results).toEqual([undefined, undefined, undefined]);
});

test("a peer's token can't be turned into the source's", async () => {
  const { peer, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const forged = altered(token, (json) => {
    json.kind = "source";
    json.sessionSig = json.grant.sig;
  });
  const granted = await authorize(path, query(forged), Date.now());
  expect(granted).toBeUndefined();
});

test("a missing or malformed token admits nothing", async () => {
  const { peer, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const now = Date.now();
  const queries = [
    undefined,
    "",
    "jwt=abc",
    "token=not-base64!",
    `token=${encoder.encode("[]").toBase64({ alphabet: "base64url" })}`,
    query(altered(token, (json) => (json.request.issuedAt = "now"))),
    query(altered(token, (json) => (json.grant.rights = "editor"))),
    query(altered(token, (json) => (json.sig = `${json.sig}A`))),
  ];
  const results = await Promise.all(queries.map((q) => authorize(path, q, now)));
  expect(results).toEqual(queries.map(() => undefined));
});

test("a token made as the docs give it admits as one `peerToken` makes", async () => {
  const { peer, grant, path } = await setup();
  const [made, written] = await Promise.all([
    peerToken(grant, peer),
    tokenAt(grant, peer, Date.now()),
  ]);
  const [fromMade, fromWritten] = await Promise.all(
    [made, written].map((t) => authorize(path, query(t), Date.now())),
  );
  expect(fromWritten).toEqual(fromMade);
  expect(fromMade === undefined).toBe(false);
});

test("the auth server keeps an admitted connection, but refuses a stale token a new one", async () => {
  const { peer, grant, path } = await setup();
  const old = await tokenAt(grant, peer, Date.now() - TOKEN_AGE - 60_000);
  const [connect, revalidate] = await Promise.all([
    post({ id: "00", event: "connect", path, query: query(old) }),
    post({ id: "00", event: "revalidate", path, query: query(old) }),
  ]);
  expect([connect.status, revalidate.status]).toEqual([403, 200]);
});

test("the auth server grants a connection, refuses a bad token and acknowledges an end", async () => {
  const { peer, peerId, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const [granted, refused, ended, wrongMethod] = await Promise.all([
    post({ id: "00", event: "connect", path, query: query(token) }),
    post({ id: "01", event: "connect", path, query: "token=x" }),
    post({ id: "00", event: "end", path, reason: "closed" }),
    authServer(new Request("http://auth/")),
  ]);
  expect(granted.status).toBe(200);
  const body = await granted.json();
  expect(body).toEqual({
    publish: [`peer/${peerId}`, `inbox/*/${peerId}`],
    subscribe: ["source", "peer/*", `inbox/${peerId}/*`],
  });
  expect([refused.status, ended.status, wrongMethod.status]).toEqual([403, 204, 405]);
});

test("a request without the relay's connection id is malformed", async () => {
  const { peer, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const responses = await Promise.all([
    post({ event: "connect", path, query: query(token) }),
    post({ event: "end", path, reason: "closed" }),
  ]);
  expect(responses.map((r) => r.status)).toEqual([400, 400]);
});

test("`admit` is asked about each connection whose token checks out, and decides it", async () => {
  const { session, peer, peerId, sessionId, grant, path } = await setup();
  const asked: Connection[] = [];
  const server = createAuthServer({
    admit: (connection) => {
      asked.push(connection);
      return connection.id !== "02";
    },
  });
  const [peerTok, sourceTok] = await Promise.all([
    peerToken(grant, peer),
    sourceToken(session, peer),
  ]);
  const responses = await Promise.all([
    server(relayPost({ id: "00", event: "connect", path, query: query(peerTok) })),
    server(relayPost({ id: "01", event: "revalidate", path, query: query(sourceTok) })),
    server(relayPost({ id: "02", event: "connect", path, query: query(peerTok) })),
    server(relayPost({ id: "03", event: "connect", path, query: "token=x" })),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200, 403, 403]);
  const byId = asked.toSorted((a, b) => a.id.localeCompare(b.id));
  expect(byId).toEqual([
    { id: "00", session: sessionId, peer: peerId, role: "peer" },
    { id: "01", session: sessionId, peer: peerId, role: "source" },
    { id: "02", session: sessionId, peer: peerId, role: "peer" },
  ]);
  const [body, expected] = await Promise.all([
    responses[1]?.json(),
    authorize(path, query(sourceTok), Date.now()),
  ]);
  expect(body).toEqual(expected);
});

test("`admit` may refuse an admitted connection when the relay asks again", async () => {
  const { peer, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const kicked = new Set(["00"]);
  const server = createAuthServer({ admit: ({ id }) => !kicked.has(id) });
  const response = await server(
    relayPost({ id: "00", event: "revalidate", path, query: query(token) }),
  );
  expect(response.status).toBe(403);
});

test("a failing `admit` or `end` answers 500, never a refusal", async () => {
  const { peer, grant, path } = await setup();
  const token = await peerToken(grant, peer);
  const server = createAuthServer({
    admit: () => Promise.reject(new Error("down")),
    end: () => {
      throw new Error("down");
    },
  });
  const responses = await Promise.all([
    server(relayPost({ id: "00", event: "connect", path, query: query(token) })),
    server(relayPost({ id: "01", event: "revalidate", path, query: query(token) })),
    server(relayPost({ id: "00", event: "end", path, reason: "closed" })),
  ]);
  expect(responses.map((r) => r.status)).toEqual([500, 500, 500]);
});

test("`end` is told the id of each connection the relay closes", async () => {
  const { path } = await setup();
  const ended: string[] = [];
  const server = createAuthServer({ end: (id) => void ended.push(id) });
  const responses = await Promise.all(
    ["00", "01"].map((id) => server(relayPost({ id, event: "end", path, reason: "closed" }))),
  );
  expect(responses.map((r) => r.status)).toEqual([204, 204]);
  expect(ended.toSorted()).toEqual(["00", "01"]);
});
