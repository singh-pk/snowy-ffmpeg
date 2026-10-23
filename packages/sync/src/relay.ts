// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The connection to the relay (docs/architecture.md#the-relay): MoQ Transport draft 18 over
// WebTransport, through the moqtail client. One connection per peer per session gives:
//
// - presence: a peer is online while its namespace `peer/<PeerId>` is announced;
// - this peer's tracks under `peer/<self>`, and subscriptions to other peers' tracks;
// - a `Link` to each online peer, over the inbox namespaces.
//
// Every object is a group of its own, so one lost or slow object never holds up another, and
// objects may arrive in any order. Everything is driven by the transport's events.

import {
  FilterType,
  FullTrackName,
  GroupOrder,
  LiveTrackSource,
  Location,
  MOQtailClient,
  MoqtObject,
  ObjectForwardingPreference,
  RequestError,
  Tuple,
  type Track,
} from "moqtail";
import { isRecord } from "./chat";
import type { Bytes, KeyId } from "./crypto";
import type { Link, LinkEvents, Message } from "./link";

export type RelayOptions = {
  /** The relay's WebTransport URL. */
  url: string;
  /**
   * For a relay whose certificate no authority signs, such as one in tests: the certificate's
   * hashes, as WebTransport takes them.
   */
  serverCertificateHashes?: WebTransportHash[];
  session: KeyId;
  /** This peer's id. */
  self: KeyId;
  /**
   * The names of the tracks this peer publishes under `peer/<self>`. They are published before
   * the peer is announced, so a peer that subscribes on seeing it online finds every one.
   */
  tracks: string[];
};

export type RelayEvents = {
  /** A peer's namespace was announced: it is online. */
  announce(peer: KeyId): unknown;
  /** A peer's namespace was withdrawn: it is offline, and its link has closed. */
  unannounce(peer: KeyId): unknown;
  /** A link to a peer has opened: each end can now reach the other. */
  link(link: Link): unknown;
  /** The connection closed, and with it every link. */
  close(): unknown;
};

/** A track this peer publishes: each object sent is a group of its own. */
type Publisher = { send(payload: Bytes): void; stop(): Promise<void> };

/** A subscription to a track, which `cancel` ends. */
type Subscription = { cancel: () => Promise<void> };

/** The relay refused a request. */
export class RelayRequestError extends Error {
  override name = "RelayRequestError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Priorities by a track name's first segment, highest first (docs/architecture.md#mapping-to-moq):
// control, then inbox, then chat, then the records, then init, then media, then probe. The order
// among media tracks, by kind, comes with the source, which knows each track's kind.
const PRIORITY: Record<string, number> = {
  control: 0,
  ctl: 1,
  deliver: 1,
  chat: 2,
  catalog: 3,
  caps: 3,
  have: 3,
  init: 4,
  media: 5,
};
const LOWEST = 6;

const priority = (name: string) => PRIORITY[name.split("/")[0] ?? name] ?? LOWEST;

// The message that opens a link, which never reaches the link's handlers.
const OPEN = "link-open";
const OPEN_BYTES = encoder.encode(JSON.stringify({ type: OPEN }));

/** An object with its key, framed as a 2-byte key length, the key, then the bytes. */
export function frame(key: string, bytes: Bytes): Bytes {
  const name = encoder.encode(key);
  if (name.length > 0xffff) throw new RangeError("an object's key is longer than 65535 bytes");
  const framed = new Uint8Array(2 + name.length + bytes.length);
  new DataView(framed.buffer).setUint16(0, name.length);
  framed.set(name, 2);
  framed.set(bytes, 2 + name.length);
  return framed;
}

/** An object framed by `frame`, or undefined for bytes that aren't one. */
export function unframe(framed: Bytes) {
  if (framed.length < 2) return undefined;

  const length = new DataView(framed.buffer, framed.byteOffset).getUint16(0);
  if (framed.length < 2 + length) return undefined;
  const key = decoder.decode(framed.subarray(2, 2 + length));
  return { key, bytes: framed.subarray(2 + length) };
}

// The path a namespace tuple names, without a leading slash.
const path = (tuple: Tuple) => tuple.toUtf8Path().replace(/^\//, "");

// A message on `ctl`, or undefined for one that isn't JSON.
function parsed(payload: Bytes): unknown {
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    return undefined;
  }
}

// Waits for what a handler returned, reporting it if it rejects.
async function settle(returned: unknown) {
  try {
    await returned;
  } catch (error) {
    reportError(error);
  }
}

// Calls a handler, reporting what it throws or rejects with rather than passing it to the
// transport event that called it, which would stop that event's loop.
function call<Args extends unknown[]>(handler: (...args: Args) => unknown, ...args: Args) {
  try {
    void settle(handler(...args));
  } catch (error) {
    reportError(error);
  }
}

// The handlers registered for each event.
function emitter<Events extends Record<string, (...args: never[]) => unknown>>(handlers: {
  [E in keyof Events]: Array<Events[E]>;
}) {
  function on<E extends keyof Events>(event: E, handler: Events[E]) {
    handlers[event].push(handler);
  }

  function emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>) {
    for (const handler of handlers[event]) call(handler, ...args);
  }

  return { on, emit };
}

// The next object on a subscription, or the end once it ends, fails or is cancelled.
async function next(reader: ReadableStreamDefaultReader<MoqtObject>) {
  try {
    return await reader.read();
  } catch {
    return { done: true as const, value: undefined };
  }
}

// Hands each object's payload on a subscription to `handle`, until it ends.
async function read(
  reader: ReadableStreamDefaultReader<MoqtObject>,
  handle: (payload: Bytes) => unknown,
) {
  for (;;) {
    const { done, value } = await next(reader);
    if (done) return;
    // moqtail types a payload over any buffer, and `Bytes` are over an `ArrayBuffer`: copied once
    // here, so what reads it, such as `unframe`, copies nothing.
    if (value.payload !== null) call(handle, new Uint8Array(value.payload));
  }
}

/**
 * Connects to the relay, publishes this peer's tracks and announces it; `listen` then starts
 * presence and links. Rejects if any of it fails.
 */
export async function connectRelay(options: RelayOptions) {
  const { session, self } = options;
  const root = `snowy/${session}`;
  const client = await MOQtailClient.new({
    url: options.url,
    transportOptions: { serverCertificateHashes: options.serverCertificateHashes ?? [] },
  });
  const events = emitter<RelayEvents>({ announce: [], unannounce: [], link: [], close: [] });
  const ownTracks = new Map<string, Publisher>();
  const links = new Map<KeyId, ReturnType<typeof relayLink>>();
  // Each closed link's teardown while it runs: a new link to that peer reuses the same names, so
  // it waits for the old one's to finish.
  const closing = new Map<KeyId, Promise<void>>();
  const online = new Set<KeyId>();
  // Peers whose inbox for this peer, `inbox/<self>/<peer>`, is announced.
  const inboxes = new Set<KeyId>();
  const state = { closed: false };

  // Publishes a track: the relay forwards it to whoever subscribes.
  async function publisher(namespace: string, name: string): Promise<Publisher> {
    const fullTrackName = FullTrackName.tryNew(namespace, name);
    const objects = Promise.withResolvers<ReadableStreamDefaultController<MoqtObject>>();
    const stream = new ReadableStream<MoqtObject>({ start: objects.resolve });
    const rank = priority(name);
    const source: Track = {
      fullTrackName,
      trackSource: { live: new LiveTrackSource(stream) },
      publisherPriority: rank,
    };
    // Sets `source.trackAlias`.
    client.addOrUpdateTrack(source);
    const controller = await objects.promise;
    const published = await client.publish(fullTrackName, true, source.trackAlias ?? 0n);

    if (published instanceof RequestError) {
      controller.close();
      client.removeTrack(source);
      throw new RelayRequestError(`publish ${namespace}/${name}`);
    }

    const { requestId } = published;
    const sent = { group: 0n, stopped: false };

    function send(payload: Bytes) {
      if (sent.stopped) throw new RelayRequestError(`${namespace}/${name} has stopped`);
      const location = new Location(sent.group++, 0n);
      const subgroup = ObjectForwardingPreference.Subgroup;
      controller.enqueue(
        MoqtObject.newWithPayload(fullTrackName, location, rank, subgroup, 0n, null, payload),
      );
    }

    async function stop() {
      if (sent.stopped) return;
      sent.stopped = true;
      controller.close();
      client.removeTrack(source);
      await client.publishDone(requestId);
    }

    return { send, stop };
  }

  // Whether the relay accepted an announcement of `namespace`.
  async function announce(namespace: string) {
    try {
      const announcement = await client.publishNamespace(Tuple.fromUtf8Path(namespace));
      return !(announcement instanceof RequestError);
    } catch {
      return false;
    }
  }

  // Subscribes to a track from now on, handing each object's payload to `handle`, once the
  // relay accepts the subscription.
  async function subscriber(
    namespace: string,
    name: string,
    handle: (payload: Bytes) => unknown,
  ): Promise<Subscription> {
    const subscribed = await client.subscribe({
      fullTrackName: FullTrackName.tryNew(namespace, name),
      priority: priority(name),
      groupOrder: GroupOrder.Original,
      forward: true,
      filterType: FilterType.NextGroupStart,
    });
    if (subscribed instanceof RequestError)
      throw new RelayRequestError(`subscribe ${namespace}/${name}`);
    const { requestId } = subscribed;
    const reader = subscribed.stream.getReader();
    void read(reader, handle);

    // moqtail ends the stream only once the publisher is done, so the reader is cancelled too.
    async function cancel() {
      try {
        await client.unsubscribe(requestId);
      } catch {
        // The connection has closed, ending the subscription anyway.
      }

      await reader.cancel();
    }

    return { cancel };
  }

  // A link to `peer` over the inbox namespaces: this peer publishes `inbox/<peer>/<self>` and
  // subscribes to `inbox/<self>/<peer>`, each with a `ctl` track for messages and a `deliver`
  // track for objects. It opens once this end has both subscriptions and has heard from the
  // other end, which sends nothing before it has both of its own.
  function relayLink(peer: KeyId) {
    const handlers = emitter<LinkEvents>({ message: [], object: [], close: [] });
    const status = {
      listening: false,
      subscribed: false,
      heard: false,
      open: false,
      closed: false,
    };
    // Whether this link's inbox from the peer has been announced, which a withdrawal of an
    // earlier one, coming late, mustn't close.
    const seen = { inbox: false };
    const subscriptions: Subscription[] = [];
    const previous = closing.get(peer);
    // What arrived before the link opened, handed to its handlers in order once it does.
    const early: Array<() => void> = [];
    const outbound = publishInbox();

    const link: Link = {
      peer,
      send: (message: Message) => void post(encoder.encode(JSON.stringify(message))),
      deliver: (key, bytes) => void put(frame(key, bytes)),
      on: handlers.on,
      close: () => void shut(),
    };

    // Publishes this end's tracks, then announces their namespace, so the other end finds both
    // when it subscribes on seeing it. Resolves with nothing if the relay refuses: the link
    // never opens, and closes with the peer.
    async function publishInbox() {
      const namespace = `${root}/inbox/${peer}/${self}`;
      await previous;
      const [ctl, deliver] = await Promise.allSettled([
        publisher(namespace, "ctl"),
        publisher(namespace, "deliver"),
      ]);
      const published = [ctl, deliver].flatMap((p) => (p.status === "fulfilled" ? [p.value] : []));

      if (ctl.status === "fulfilled" && deliver.status === "fulfilled") {
        const accepted = await announce(namespace);
        if (accepted) return { namespace, ctl: ctl.value, deliver: deliver.value };
      }

      await Promise.allSettled(published.map((side) => side.stop()));
      return undefined;
    }

    async function post(payload: Bytes) {
      const sides = await outbound;
      if (sides !== undefined && !status.closed) sides.ctl.send(payload);
    }

    async function put(payload: Bytes) {
      const sides = await outbound;
      if (sides !== undefined && status.open && !status.closed) sides.deliver.send(payload);
    }

    // Opens the link, then hands on what arrived early. Answers with an open of its own when
    // this end's first one may have gone before the other end subscribed.
    function open(answer: boolean) {
      status.open = true;
      if (answer) void post(OPEN_BYTES);
      events.emit("link", link);
      for (const arrival of early.splice(0)) arrival();
    }

    // Something arrived from the other end, which proves it subscribed to this one: the link
    // opens if this end has subscribed too. `deliver` is what goes to the handlers, if anything.
    function arrived(deliver?: () => void) {
      if (status.closed) return;

      if (status.open) {
        deliver?.();
        return;
      }

      if (deliver !== undefined) early.push(deliver);
      status.heard = true;
      if (status.subscribed) open(true);
    }

    function heard(payload: Bytes) {
      const value = parsed(payload);
      if (value === undefined) return;
      const opening = isRecord(value) && value.type === OPEN;
      arrived(opening ? undefined : () => handlers.emit("message", value));
    }

    function object(payload: Bytes) {
      const framed = unframe(payload);
      if (framed !== undefined) arrived(() => handlers.emit("object", framed.key, framed.bytes));
    }

    // Keeps a subscription, or ends it if the link closed while the relay was answering.
    async function keep(subscribing: Promise<Subscription>) {
      const subscription = await subscribing;
      subscriptions.push(subscription);
      if (status.closed) await subscription.cancel();
    }

    // The other end has published its side: subscribe, then say this end is listening.
    async function inbound() {
      if (status.listening || status.closed) return;
      status.listening = true;
      const namespace = `${root}/inbox/${self}/${peer}`;

      try {
        await Promise.all([
          keep(subscriber(namespace, "ctl", heard)),
          keep(subscriber(namespace, "deliver", object)),
        ]);
      } catch {
        // The relay refused: the link never opens, and closes with the peer.
        return;
      }

      if (status.closed) return;
      status.subscribed = true;
      await post(OPEN_BYTES);
      if (status.heard && !status.open && !status.closed) open(false);
    }

    async function shut() {
      if (status.closed) return;
      status.closed = true;
      links.delete(peer);
      early.length = 0;
      const wasOpen = status.open;
      status.open = false;
      if (wasOpen) handlers.emit("close");

      const teardown = tearDown();
      closing.set(peer, teardown);
      await teardown;
      if (closing.get(peer) === teardown) closing.delete(peer);
    }

    // Ends this link's subscriptions and withdraws its tracks and their namespace.
    async function tearDown() {
      await Promise.allSettled(subscriptions.map((subscription) => subscription.cancel()));
      const sides = await outbound;
      if (sides === undefined || state.closed) return;

      try {
        await Promise.all([sides.ctl.stop(), sides.deliver.stop()]);
        await client.unpublishNamespace(Tuple.fromUtf8Path(sides.namespace));
      } catch {
        // The connection closed meanwhile, which withdraws them anyway.
      }
    }

    return { link, seen, inbound, shut };
  }

  function linkTo(peer: KeyId) {
    const existing = links.get(peer);
    if (existing !== undefined) return existing;

    const created = relayLink(peer);
    links.set(peer, created);
    return created;
  }

  // Subscribes to a peer's side of its link, once both its namespace and its inbox for this
  // peer are announced, which may come in either order.
  function hearFrom(peer: KeyId) {
    if (online.has(peer) && inboxes.has(peer)) void linkTo(peer).inbound();
  }

  function announced(prefix: string, peer: string) {
    if (prefix === `${root}/peer` && peer !== self && !online.has(peer)) {
      online.add(peer);
      linkTo(peer);
      events.emit("announce", peer);
      hearFrom(peer);
    }

    if (prefix === `${root}/inbox/${self}`) {
      inboxes.add(peer);
      linkTo(peer).seen.inbox = true;
      hearFrom(peer);
    }
  }

  function withdrawn(prefix: string, peer: string) {
    if (prefix === `${root}/peer` && online.delete(peer)) {
      void links.get(peer)?.shut();
      events.emit("unannounce", peer);
    }

    if (prefix === `${root}/inbox/${self}` && inboxes.delete(peer)) {
      const link = links.get(peer);
      if (link?.seen.inbox === true) void link.shut();
    }
  }

  client.onPeerNamespace = (prefix, suffix) => announced(path(prefix), path(suffix));
  client.onPeerNamespaceDone = (prefix, suffix) => withdrawn(path(prefix), path(suffix));

  client.onSessionTerminated = () => {
    if (state.closed) return;
    state.closed = true;
    for (const { shut } of links.values()) void shut();
    events.emit("close");
  };

  // Ends the connection, and is safe to call again. moqtail's `disconnect` leaves the
  // WebTransport session open, as it tests the session's `closed` promise for truth, so the
  // session is closed here; and moqtail disconnects by itself on an internal error, so `close`
  // calls this even once the connection has closed.
  async function end() {
    await client.disconnect();

    try {
      client.webTransport.close();
      await client.webTransport.closed;
    } catch {
      // It was closed already, or closed with an error: either way, it is closed.
    }
  }

  async function own(name: string) {
    const published = await publisher(`${root}/peer/${self}`, name);
    ownTracks.set(name, published);
  }

  try {
    await Promise.all(options.tracks.map(own));
    const announcement = await client.publishNamespace(Tuple.fromUtf8Path(`${root}/peer/${self}`));
    if (announcement instanceof RequestError) throw new RelayRequestError("announce");
  } catch (error) {
    await end();
    throw error;
  }

  async function watch(prefix: string) {
    const { response } = await client.subscribeNamespace(Tuple.fromUtf8Path(prefix));
    if (response instanceof RequestError) throw new RelayRequestError(`watch ${prefix}`);
  }

  /**
   * Starts presence and links: subscribes to this peer's inboxes and to the peers' namespaces,
   * so `announce` fires for every peer online, and `link` as each link opens. Called once the
   * handlers are registered, so none misses an event.
   */
  async function listen() {
    await watch(`${root}/inbox/${self}`);
    await watch(`${root}/peer`);
  }

  /** One of this peer's tracks, `peer/<self>/<name>`; each object goes as a group. */
  function track(name: string) {
    const published = ownTracks.get(name);
    if (published === undefined) throw new Error(`${name} isn't one of this peer's tracks`);
    return published;
  }

  /**
   * Subscribes to a peer's track, `peer/<peer>/<name>`, from its next object on. Resolves with
   * a function that ends the subscription.
   */
  async function subscribe(peer: KeyId, name: string, handle: (payload: Bytes) => unknown) {
    const { cancel } = await subscriber(`${root}/peer/${peer}`, name, handle);
    return cancel;
  }

  /** Withdraws this peer and closes the connection. */
  async function close() {
    await end();
  }

  return { on: events.on, listen, track, subscribe, close };
}
