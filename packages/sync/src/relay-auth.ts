// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Relay authorization (docs/architecture.md#authorization): the join grant, the token a peer
// dials the relay with, and the auth server moq-relay asks (`--auth-url`), which checks a token
// and answers with what its peer may publish and subscribe to. The server keeps nothing: each
// answer comes from the token and the dialed path alone, and from the app's `admit` when it
// passes one, which keeps whatever state its own policy needs. It is a `fetch` handler on Web
// Crypto, so it runs wherever that does: `Bun.serve({ fetch: authServer })`, or a Worker.

import { isRecord } from "./chat";
import {
  isKeyId,
  keyId,
  publicKey,
  sigBytes,
  sign,
  verify,
  type Bytes,
  type KeyId,
} from "./crypto";

/** How long a token admits a connection after it is made. */
export const TOKEN_AGE = 5 * 60_000;
/** How far ahead of the auth server's clock a token may be made. */
export const TOKEN_SKEW = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The session key's leave for anyone holding the invite to join: it goes in the invite link. */
export type JoinGrant = { session: KeyId; rights: "viewer"; sig: string };

/** What a peer signs to connect: who it is, the session, and when, in milliseconds. */
type ConnectionRequest = { peer: KeyId; session: KeyId; issuedAt: number };

type Token =
  | { kind: "peer"; grant: JoinGrant; request: ConnectionRequest; sig: string }
  | { kind: "source"; request: ConnectionRequest; sig: string; sessionSig: string };

/** What the relay lets a connection do: moq-relay's grant, patterns relative to the dialed path. */
export type RelayGrant = { publish: string[]; subscribe: string[] };

const base64 = (bytes: Bytes) => bytes.toBase64({ alphabet: "base64url", omitPadding: true });

// Each signed thing has its own prefix, so a signature over one can't pass for another.
const grantBytes = (session: KeyId) =>
  encoder.encode(`snowy join v1\n${JSON.stringify({ session, rights: "viewer" })}`);

const requestBytes = (prefix: string, { peer, session, issuedAt }: ConnectionRequest) =>
  encoder.encode(`${prefix}\n${JSON.stringify({ peer, session, issuedAt })}`);

const encode = (token: Token) => base64(encoder.encode(JSON.stringify(token)));

/** The join grant for the session whose key pair this is. */
export async function joinGrant(session: CryptoKeyPair): Promise<JoinGrant> {
  const id = await keyId(session.publicKey);
  const sig = await sign(session.privateKey, grantBytes(id));
  return { session: id, rights: "viewer", sig: base64(sig) };
}

async function connectionRequest(peer: CryptoKeyPair, session: KeyId) {
  const id = await keyId(peer.publicKey);
  const request = { peer: id, session, issuedAt: Date.now() };
  const sig = await sign(peer.privateKey, requestBytes("snowy relay v1", request));
  return { request, sig: base64(sig) };
}

/**
 * A peer's token for the relay, from the session's join grant. It admits a connection for
 * `TOKEN_AGE` after it is made, so a peer makes one each time it connects.
 */
export async function peerToken(grant: JoinGrant, peer: CryptoKeyPair) {
  const { request, sig } = await connectionRequest(peer, grant.session);
  return encode({ kind: "peer", grant, request, sig });
}

/** The source's token for the relay, signed by both the session key and its own peer key. */
export async function sourceToken(session: CryptoKeyPair, peer: CryptoKeyPair) {
  const id = await keyId(session.publicKey);
  const { request, sig } = await connectionRequest(peer, id);
  const sessionSig = await sign(session.privateKey, requestBytes("snowy source v1", request));
  return encode({ kind: "source", request, sig, sessionSig: base64(sessionSig) });
}

// The session a dialed path is the root of: it ends in `snowy/<SessionId>`, under whatever path
// the relay's URL has. Each prefix roots a separate tree, and a grant's patterns are relative to
// it, so a peer that dials another prefix reaches only peers that dialed the same.
function sessionOf(path: string) {
  const parts = path.split("/");
  const session = parts.at(-1);
  return parts.at(-2) === "snowy" && isKeyId(session) ? session : undefined;
}

function checkRequest(value: unknown): ConnectionRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { peer, session, issuedAt } = value;
  const valid = isKeyId(peer) && isKeyId(session) && typeof issuedAt === "number";
  return valid && Number.isSafeInteger(issuedAt) ? { peer, session, issuedAt } : undefined;
}

// The token in a dialed query, `token=…`, checked for shape only, or undefined.
function readToken(query: string | undefined): Token | undefined {
  const param = new URLSearchParams(query ?? "").get("token");
  if (param === null) return undefined;

  let json: unknown;

  try {
    json = JSON.parse(decoder.decode(Uint8Array.fromBase64(param, { alphabet: "base64url" })));
  } catch {
    return undefined;
  }

  if (!isRecord(json) || typeof json.sig !== "string") return undefined;
  const request = checkRequest(json.request);
  if (request === undefined) return undefined;
  const { kind, grant, sig, sessionSig } = json;

  if (kind === "peer" && isRecord(grant)) {
    const { session, rights, sig: grantSig } = grant;
    const valid = isKeyId(session) && rights === "viewer" && typeof grantSig === "string";
    return valid ? { kind, grant: { session, rights, sig: grantSig }, request, sig } : undefined;
  }

  if (kind === "source" && typeof sessionSig === "string") {
    return { kind, request, sig, sessionSig };
  }

  return undefined;
}

// Whether `sig` is the key's signature of `data`, in its one spelling.
async function signed(key: KeyId, sig: string, data: Bytes) {
  const bytes = sigBytes(sig);
  if (bytes === undefined) return false;
  const imported = await publicKey(key);
  return verify(imported, bytes, data);
}

// Whether every signature on a token checks out, by the keys of `session` and its peer.
async function verified(token: Token, session: KeyId) {
  const { request } = token;
  const bySession =
    token.kind === "peer"
      ? token.grant.session === session && signed(session, token.grant.sig, grantBytes(session))
      : signed(session, token.sessionSig, requestBytes("snowy source v1", request));
  const checks = await Promise.all([
    bySession,
    signed(request.peer, token.sig, requestBytes("snowy relay v1", request)),
  ]);
  return checks.every(Boolean);
}

const peerGrant = (peer: KeyId): RelayGrant => ({
  publish: [`peer/${peer}`, `inbox/*/${peer}`],
  subscribe: ["source", "peer/*", `inbox/${peer}/*`],
});

const sourceGrant = (peer: KeyId): RelayGrant => ({
  publish: ["source", `peer/${peer}`, `inbox/*/${peer}`],
  subscribe: ["**"],
});

// The token a connection dialed at `path` with `query`, once every check passed, or undefined.
async function checked(path: string, query: string | undefined, now: number, fresh: boolean) {
  const session = sessionOf(path);
  const token = readToken(query);
  if (session === undefined || token === undefined) return undefined;

  const { request } = token;
  if (request.session !== session) return undefined;
  const age = now - request.issuedAt;
  if (fresh && (age > TOKEN_AGE || age < -TOKEN_SKEW)) return undefined;

  const ok = await verified(token, session);
  return ok ? token : undefined;
}

const grantOf = ({ kind, request }: Token) =>
  kind === "source" ? sourceGrant(request.peer) : peerGrant(request.peer);

/**
 * What a connection dialed at `path` with `query` may do, or undefined if its token admits
 * nothing. A new connection's token must be fresh at `now`; a connection already admitted keeps
 * what it was given (`fresh` false).
 */
export async function authorize(
  path: string,
  query: string | undefined,
  now: number,
  fresh = true,
): Promise<RelayGrant | undefined> {
  const token = await checked(path, query, now, fresh);
  return token === undefined ? undefined : grantOf(token);
}

/** A connection whose token checked out: the relay's id for it, its session, its peer and role. */
export type Connection = { id: string; session: KeyId; peer: KeyId; role: "source" | "peer" };

/**
 * The app's say in who the relay admits, beyond what the keys allow (docs/architecture.md#admission).
 * The package keeps no state for it: an app that counts connections keeps them by `id`.
 */
export type Admission = {
  /** Whether to admit a connection whose token checked out, asked on `connect` and `revalidate`. */
  admit?: (connection: Connection) => boolean | Promise<boolean>;
  /** The relay reports an admitted connection closed, by its id; one refused on `connect` has no end. */
  end?: (id: string) => void | Promise<void>;
};

const status = (code: number) => new Response(null, { status: code });

/**
 * The auth server, as a `fetch` handler for moq-relay's `--auth-url`: it answers each request
 * the relay posts about a session with a grant, or 403. A failure in `admission` answers 500,
 * which refuses a new connection, leaves an admitted one to be asked again, and is only logged
 * for an `end`.
 */
export function createAuthServer(admission: Admission = {}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return status(405);

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return status(400);
    }

    if (!isRecord(body) || typeof body.path !== "string" || typeof body.id !== "string") {
      return status(400);
    }

    const { id, event, path } = body;
    const query = typeof body.query === "string" ? body.query : undefined;

    if (event === "end") {
      try {
        await admission.end?.(id);
      } catch {
        return status(500);
      }

      return status(204);
    }

    if (event !== "connect" && event !== "revalidate") return status(400);

    let token: Token | undefined;

    // A token that breaks the check refuses, as one that fails it does, not as a server error.
    try {
      token = await checked(path, query, Date.now(), event === "connect");
    } catch {
      token = undefined;
    }

    if (token === undefined) return status(403);
    const { session, peer } = token.request;
    let admitted: boolean | undefined;

    try {
      admitted = await admission.admit?.({ id, session, peer, role: token.kind });
    } catch {
      return status(500);
    }

    return admitted === false ? status(403) : Response.json(grantOf(token));
  };
}

/** The auth server that admits every connection whose token checks out. */
export const authServer = createAuthServer();
