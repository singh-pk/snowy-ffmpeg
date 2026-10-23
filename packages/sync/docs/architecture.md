# Architecture

How @snowy-media/sync is built: one person plays a local media file to a group of viewers, everyone shares a chat, and each viewer picks their own audio and subtitle tracks. For using it, start with the [README](../README.md).

## Contents

1. [Principles](#principles)
2. [Infrastructure](#infrastructure)
3. [Platform baseline](#platform-baseline)
4. [Package boundaries](#package-boundaries)
5. [Identity, sessions and access](#identity-sessions-and-access)
6. [Roles](#roles)
7. [Track layout](#track-layout)
8. [Objects](#objects)
9. [Local store](#local-store)
10. [Media at the source](#media-at-the-source)
11. [Media delivery](#media-delivery)
12. [Peer groups](#peer-groups)
13. [Playback control](#playback-control)
14. [Audio and subtitle choice](#audio-and-subtitle-choice)
15. [Chat](#chat)
16. [Presence and membership](#presence-and-membership)
17. [Events](#events)
18. [The relay](#the-relay)
19. [Security](#security)
20. [Session lifecycle](#session-lifecycle)
21. [Requirements on @snowy-media/engine](#requirements-on-snowy-mediaengine)
22. [Constants](#constants)
23. [Limits](#limits)

## Principles

| Principle | Meaning |
| --- | --- |
| **Local-first** | Every peer keeps its own copy of everything it has received. The interface reads only from that copy, never from the network. Losing the network loses nothing that was already received. |
| **One writer per object** | Each object has exactly one author: the source writes media, control and the catalog, and each peer writes its own chat and records. Two peers never write the same object, so nothing needs merging. |
| **Event-driven** | Snowy's code has no timers and polls nothing. Every action responds to an event from the transport, the engine, the store or the user. The only clocks are the transports' keepalives and the engine's media clock, and both reach Snowy as events. |
| **Each byte crosses each link once** | No peer receives the same object twice. The source pushes each chunk to the relay once. It sends a chunk again only to a peer that asks for one no forwarder holds. |
| **Metadata goes only to those who need it** | What a forwarder holds goes to its group, and a receiver's capability record goes to the source. Records are sent when they change, never repeated. |
| **A stateless relay** | The relay forwards objects and forgets them. It stores nothing and runs no timers. Peers are the only storage. |
| **One code path** | Every peer runs the same logic. Roles come from measured values and user settings, never from browser or device detection. |

## Infrastructure

| Piece | Purpose | Requirement |
| --- | --- | --- |
| **Relay** | Fans out objects, carries signaling, and is the route for peers that can't connect directly | Speaks MoQ Transport over WebTransport, keeps no objects after forwarding them, and authorizes requests with tokens signed by the session key ([The relay](#the-relay)) |
| **STUN, two endpoints** | Lets peers learn their public address for WebRTC, and classify their NAT | Two endpoints on different IP addresses |
| **Static hosting** | Serves the app | Sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` |

Nothing else exists. There is no TURN server, signaling server, database, account system, token service or any per-session state on a server.

## Platform baseline

The engine's baseline, plus:

| Feature | Used for |
| --- | --- |
| WebTransport | The connection to the relay |
| `RTCPeerConnection` and `RTCDataChannel` | Direct links inside a peer group |
| Origin Private File System (OPFS) | Media chunks and logs in the local store |
| IndexedDB | Non-extractable `CryptoKey`s in the local store |
| Web Crypto: Ed25519, AES-GCM, HKDF, SHA-256 | Signatures, encryption, deriving keys, content hashes |
| `navigator.storage.persist()` | Keeping the local store from being evicted |

`createSync` checks all of them once and rejects with an `UnsupportedPlatformError` naming the first one missing. Nothing else checks for features.

## Package boundaries

- `@snowy-media/sync` is its own package, MIT-licensed.
- It uses `@snowy-media/engine` only through the engine's public exports.
- The engine knows nothing about networks. It plays packets from whatever packet source it is given ([Requirements on @snowy-media/engine](#requirements-on-snowy-mediaengine)).
- Both transports sit behind one `Link` interface. The scheduler, store and chat never refer to MoQ or WebRTC directly.

```ts
type Link = {
  peer: PeerId;
  send(message: Message): void;              // control messages: have, request, busy, …
  deliver(key: ObjectKey, bytes: Uint8Array): void;
  on(event: LinkEvent, handler: Handler): void;
  close(): void;
};
```

## Identity, sessions and access

### Keys

| Key | Type | Held by | Purpose |
| --- | --- | --- | --- |
| **Peer key** | Ed25519 key pair, one per device per session | Every peer, the source included | Identifies the peer and signs its capability records, chat checkpoints and relay requests. `PeerId` is the base64url public key. |
| **Session key** | Ed25519 key pair | The source | Signs the catalog, chunk headers, control records and join grants, and authenticates the source to the relay. `SessionId` is the base64url public key. |
| **Session secret** | 32 random bytes | Everyone with the invite | HKDF derives the content encryption key from it |

Private keys are generated non-extractable and kept in IndexedDB ([Local store](#local-store)).

### Invite link

```text
https://<app>/watch#v=1&relay=<relay URL>&s=<SessionId>&k=<session secret>&g=<join grant>
```

- Everything sits in the URL **fragment**, which browsers never send to any server, the static host included.
- Anyone with the link can join. The link *is* the access model.

### Join grant

A join grant is signed by the session key, so viewers can join while the source is offline.

```ts
type JoinGrant = {
  session: SessionId;
  rights: "viewer";
  sig: string;                // Ed25519 by the session key
};
```

A peer's relay token is the grant plus a request the peer signs with its own key (`{ peer, session, issuedAt }`). The relay checks both signatures and allows that peer to publish only under its own namespaces ([The relay](#the-relay)).

The source's token is a request signed by both the session key and the source's peer key. It grants `source/*` plus everything a peer may publish under the source's own `PeerId`.

## Roles

| Role | Who | Uploads |
| --- | --- | --- |
| **Source** | The peer with the file. There is exactly one per session. | Every chunk once to the relay; control; the catalog; chunks asked for when no forwarder holds them |
| **Forwarder** | A peer that meets every rule for becoming a forwarder (below) | Chunks to the peers in its group |
| **Receiver** | Every other peer | No media. Its own chat and records only. |

Every peer, the source included, sends and receives chat and has a `PeerId`.

### How each peer assesses itself

Each peer works out its own role from values it can measure:

| Input | How it's obtained |
| --- | --- |
| **NAT class** | Gather server-reflexive candidates against both STUN endpoints. The same public port from both → `cone`. Different ports → `symmetric`. |
| **Upload capacity** | **Probe:** on join, and when the user turns Share my upload on, the peer publishes a probe of one second of `sessionBitrate` (at most 2 MB) on `peer/<self>/probe`, which only it subscribes to. Capacity is the probe's size divided by the time from first byte written to last byte received back. **While forwarding:** bytes acknowledged per second over each completed delivery replace the probe value. |
| **Visibility** | `document.visibilityState`, from the `visibilitychange` event |
| **Willingness** | The user setting **Share my upload**. Asked when a peer first joins, with nothing preselected. There is no device-based default. |

The NAT test doesn't detect port-restricted filtering. A pair that passes it but can't connect finds out from the ICE result ([Signaling](#signaling)).

**Becomes a forwarder** when *all* of the following hold:

- `nat` is `cone`
- Share my upload is on
- the tab is visible
- `measuredUpload × 0.6 ≥ sessionBitrate`, so the peer has at least one slot

**Stops forwarding** when *any* of the following happens:

- `measuredUpload < sessionBitrate`
- the tab becomes hidden
- the user turns Share my upload off

Becoming a forwarder and stopping happen at different upload levels (1.67× and 1× the session bitrate), so a peer near one value doesn't switch back and forth.

**Slots** (the number of peers a forwarder serves at once):

```text
slots = floor(measuredUploadKbps × 0.6 / sessionBitrateKbps)
```

`sessionBitrateKbps` is the video bitrate, plus the bitrates of the audio tracks being pushed, plus the subtitle tracks, all from the catalog.

### Capability record

```ts
type Caps = {
  peer: PeerId;
  version: number;             // increases on every change, kept in the local store
  role: "source" | "forwarder" | "receiver";
  nat: "cone" | "symmetric";
  slots: number;               // 0 unless forwarder
  freeSlots: number;
  audio: number;               // selected audio track id
  rttToRelayMs: number;
  sig: string;                 // Ed25519 by the peer key
};
```

A capability record is signed by the peer, so it can be passed on by others. It is published only when one of its fields changes. Where it goes depends on the role:

- **The source and forwarders** publish on `peer/<self>/caps`, which every peer subscribes to, so receivers can find forwarders.
- **Receivers** send theirs to the source only, on `inbox/<source PeerId>/<self>`. The source needs their `audio` selection.

## Track layout

Every name sits under the namespace `snowy/<SessionId>`. The relay enforces who may publish each one.

| Namespace / track | Publisher | Subscribers | Content |
| --- | --- | --- | --- |
| `source` / `catalog` | Source | All | [Catalog](#catalog) |
| `source` / `control` | Source | All | [Control record](#control-record) |
| `source` / `init/<track>` | Source | All | Codec setup for one media track |
| `source` / `media/<track>` | Source | Forwarders and receivers without a forwarder | Media chunks for video, audio and subtitle tracks |
| `peer/<PeerId>` / `caps` | The source and forwarders | All | Capability record |
| `peer/<PeerId>` / `chat` | That peer | All | Chat messages and checkpoints |
| `peer/<PeerId>` / `have` | Forwarders | That forwarder's group | What chunks the forwarder holds |
| `peer/<PeerId>` / `probe` | That peer | That peer only | The upload probe |
| `inbox/<recipient>` / `<sender>` | The sender | The recipient | Requests, replies, signaling, clock sync, receivers' capability records |
| `inbox/<recipient>` / `deliver/<sender>` | The sender | The recipient | Objects sent on request |

### Mapping to MoQ

- One media chunk is one MoQ group with one object, sent on its own QUIC stream.
- One chat message, or one batch of messages, is one group with one object.
- `catalog`, `control` and `caps` publish a new group for every new version. A subscriber keeps only the newest.
- Priorities, highest first: `control`, then `inbox`, then `chat`, then `catalog`, `caps` and `have`, then `init`, then `media` (subtitle, then audio, then video), then `probe`.

## Objects

| Object | Key | Writer | Size | Authenticated by |
| --- | --- | --- | --- | --- |
| Catalog | `catalog@version` | Source | About 1 KB | Session-key signature |
| Control record | `control@epoch` | Source | About 100 B | Session-key signature |
| Codec setup | `init/<track>` | Source | Under 1 KB | Session-key signature |
| Media chunk | `media/<track>/<index>` | Source | One GOP: typically 1–5 MB for video, tens of KB for audio and text subtitles, up to a few MB for bitmap subtitles | Signed chunk header |
| Chat batch | `chat/<author>/<firstSeq>-<lastSeq>` | Author | About 150 B per message | Hash chain plus a signed checkpoint |
| Capability record | `caps/<peer>@version` | That peer | About 150 B | Peer-key signature |
| Have ranges | `have/<peer>@n` | That forwarder | Tens of bytes | Relay authorization |

Every object is encrypted.

### Encryption

- **Content key:** `HKDF-SHA256(sessionSecret, salt = SessionId, info = "snowy content v1")`, used as an AES-256-GCM key.
- **Nonce:** 96 random bits from `crypto.getRandomValues` for every encryption, sent in front of the ciphertext. The nonce never depends on the object key, so a replaced object, a re-sent batch or a lost counter can't reuse one. At the session's scale, random 96-bit nonces stay far below the AES-GCM limit of 2³² encryptions per key.
- **Associated data:** the object key, so ciphertext can't be moved to a different key.
- Peers store and forward the **encrypted bytes unchanged**. They decrypt only to read.
- The relay sees only encrypted data, plus the track names and sizes.

### Catalog

```ts
type Catalog = {
  version: number;
  durationUs: number;
  tracks: Array<{
    id: number;
    kind: "video" | "audio" | "subtitle";
    codec: string;               // WebCodecs codec string, or the subtitle format
    bitrateKbps: number;
    language?: string;
    title?: string;
  }>;
  chunkCount?: number;           // set once demuxing has reached the end of the file
  sig: string;
};
```

### Media chunk

```text
ChunkHeader (signed, plaintext inside the encrypted object)
  session      SessionId
  track        u16
  index        u32
  startUs      i64     inclusive, the pts of the chunk's keyframe
  endUs        i64     exclusive, the startUs of the next chunk
  count        u32     packets
  bodyHash     SHA-256 of the body
  sig          Ed25519 by the session key over every field above
Body
  count × PacketRecord, in decode order
    ptsUs       i64
    dtsUs       i64
    durationUs  u32
    flags       u8      bit 0: keyframe
    size        u32
    bytes       [size]
```

- Timestamps are in microseconds for every track, so every track shares one timeline.
- A peer stores a chunk only once the signature and `bodyHash` both check out. It throws away anything that fails without storing it.

## Local store

```text
OPFS  snowy/<SessionId>/
        catalog            newest catalog
        control            newest control record
        init/<track>
        media/<track>/<index>
        chat/<author>      append-only log, one record per message
        peers/<PeerId>     newest caps record of each known peer
        counters           this peer's caps version and chat seq
IDB   snowy-keys / <SessionId>
        peer               this device's peer key pair (non-extractable)
        session            the session key pair (the source only, non-extractable)
```

- `navigator.storage.persist()` is requested when a peer joins.
- **Rolling window (default):** keep chunks from 2 minutes behind the playhead to 15 minutes ahead. A chunk is deleted when a playhead event leaves it outside the window.
- **Full film (opt-in):** keep every chunk until the session is left.
- The store emits `stored(key)` and `deleted(key)`, which drive the scheduler and what the peer advertises.

## Media at the source

### Demuxing and cutting chunks

1. The source opens the file with the engine's demuxer.
2. **Video:** a chunk spans at least 2 seconds and closes at the first keyframe after that. Every video chunk starts on a keyframe. Its length is bounded only by the file's keyframe interval, because cutting inside a GOP would stop chunks from decoding on their own.
3. **Leading pictures:** packets stay in decode order with the GOP they belong to. In an open GOP, pictures after the keyframe in decode order but with a pts before `startUs` (such as RASL pictures) stay in that chunk. A peer that starts decoding at a chunk discards every frame with a pts before `startUs`.
4. **Audio and subtitles:** for every video chunk `[startUs, endUs)`, each audio and subtitle track gets a chunk with the same index containing every packet whose `ptsUs` falls in that range. The same index means the same time range in every track. A subtitle cue that starts in one chunk and ends in a later one stays in the chunk where it starts.
5. **Codec setup:** one `init/<track>` object per track holding the codec string, WebCodecs `description` (extradata), coded size, sample rate and channel count.

### Push order

The source keeps a single priority queue. A chunk's priority, highest first:

1. Chunks covering a **seek target**, from the target onwards
2. Chunks a peer has **asked the source for** ([Media delivery](#media-delivery))
3. Chunks **ahead of the playhead**, in time order. At each index: every subtitle track, then every audio track at least one peer has selected, then video.

The source sends the next chunk as soon as the relay stream will accept more data (when its writer's `ready` promise resolves). It doesn't wait for playback, so pushing runs as fast as the source's upload. Chunks outside every peer's storage window are never pushed.

### Which tracks are pushed

- **Video:** always.
- **Subtitles:** every subtitle track, always. Switching subtitles is then local and immediate.
- **Audio:** every audio track that appears in at least one peer's `caps.audio`. When a selection first appears, that track jumps in the queue from the current playhead. When the last peer stops selecting a track, its chunks stop being pushed.

## Media delivery

### Who subscribes live

| Peer | Media from the relay |
| --- | --- |
| Forwarder | Live subscription to `media/<track>` for video, its selected audio and every subtitle track |
| Receiver with `nat: symmetric` | Live subscription, the same as a forwarder |
| Receiver connected to at least one forwarder | **No live subscription.** Asks for specific chunks only (below). |
| Receiver not connected to any forwarder | Live subscription until a forwarder connects |

### Choosing where each chunk comes from

The scheduler runs on events (`progress`, `have`, `stored`, `close`, `busy`, `gone`) and nothing else. For every chunk the peer needs and doesn't yet hold:

```text
covered by a live subscription?              → wait for it to arrive
urgent? (inside the urgent window: playhead to playhead + 30 s)
├─ a connected forwarder advertises it with a free slot
│     → ask that forwarder, lowest RTT first
└─ otherwise → ask the source, through inbox/<source>/<self>
not urgent
├─ a connected forwarder advertises it with a free slot
│     → ask that forwarder, lowest RTT first
└─ otherwise → wait for the next `have` or `progress` event
```

- **One request per chunk at a time.** A chunk is asked from a second source only after one of these events about the first:

  | Event | Then |
  | --- | --- |
  | `busy` reply | Ask the next forwarder that has it, or the source if the chunk is urgent |
  | `gone` reply (the forwarder no longer holds it) | Same as `busy` |
  | The link's `close` event | Every request on that link goes back into the plan |
  | A `progress` event makes the chunk urgent while the forwarder has sent no piece of it | Cancel the forwarder request and ask the source |

- **Requests are cancelled explicitly** with a `cancel` message, so the sender stops sending.
- **Duplicates can't be stored twice:** a chunk that arrives after the same key was stored is thrown away unread, and its request is cancelled.

### Requests to the source

- The source answers through `inbox/<requester>/deliver/<source>`, ahead of everything else in its queue except seek targets.
- **While the source is offline,** urgent chunks that no forwarder holds wait for a `have` event or the source's return. The peer pauses locally when its buffer runs out ([Playback control](#playback-control)).
- A joiner without a forwarder gets its urgent window from the source this way. That is the only time the source sends a chunk more than once.

### Have ranges

- Forwarders receive chunks in order, so what they hold is normally one range per track: `{ track, ranges: [[start, end], …] }`.
- On every `stored` and `deleted` event, the forwarder collects the change and publishes a new `have` when the stream will accept more data. Several stores in a burst therefore become one update.
- Only the forwarder's group subscribes. `have` is not secret, so the relay doesn't restrict who may subscribe.

## Peer groups

### Forming a group

1. A receiver that isn't `symmetric` reads every forwarder's capability record from the session.
2. It sends WebRTC offers, through its inbox tracks on the relay, to up to **8** forwarders that have free slots.
3. When a connection opens, it reads that connection's `currentRoundTripTime` from the connection stats.
4. Once every attempt has either opened or failed, it **keeps the 4 lowest-RTT connections** and closes the rest.
5. Whenever a connection closes, or a forwarder's record changes to `freeSlots: 0`, the receiver tries the next-best forwarder from its candidate list.

Forwarders form groups among themselves the same way, so chunks can move between forwarders when one misses a chunk from the relay.

### Signaling

- Offers, answers and ICE candidates travel as messages on `inbox/<recipient>/<sender>`.
- ICE servers are the two STUN endpoints only. There is no TURN.
- A pair whose ICE check fails stays relay-only, and neither side retries until one of their capability records changes.
- `symmetric` peers never take part in WebRTC.

### Data channels

Each connection has two data channels:

| Channel | Reliable | Ordered | Carries |
| --- | --- | --- | --- |
| `ctl` | Yes | Yes | `have`, `request`, `cancel`, `busy`, `gone` |
| `data` | Yes | **No** | Chunk pieces |

- A chunk travels in messages of at most 64 KiB, header included. Each header is `{ key, offset, total }`. Because the channel is unordered, one lost piece never delays pieces of other chunks.
- Sending pauses when `bufferedAmount` reaches 1 MiB and resumes on the `bufferedamountlow` event, with the threshold at 256 KiB.
- RTT is read from the connection stats when the connection opens and again each time a chunk delivery on it completes.

## Playback control

### Control record

```ts
type Control = {
  epoch: number;           // increases on every play, pause or seek; kept in the source's local store
  playing: boolean;
  mediaUs: number;         // position at `atUs`
  atUs: number;            // source clock, microseconds
  ended: boolean;
  sig: string;
};
```

- **Only the source** writes control. Viewers can't play, pause or seek for the group.
- **Clock:** every peer uses `(performance.timeOrigin + performance.now()) × 1000`, wall time in microseconds at high resolution. The measured offset turns the source's `atUs` into the local clock.
- Playback always runs at normal speed. The position a viewer should be at is `mediaUs + (sourceNow − atUs)` while playing, and `mediaUs` while paused.

### Clock offset

- On join, and whenever drift correction finds more than 500 ms of error, the peer measures its clock offset from the source over the inbox tracks. It sends 5 exchanges of `{ t0 }` → `{ t0, t1, t2 }`, each one sent when the previous reply arrives.
- The exchange with the lowest round-trip time gives the offset `((t1 − t0) + (t2 − t3)) / 2`.
- While the source is offline, the last offset stays in use.

### Correcting drift

On every engine `progress` event, a peer compares its playhead to where it should be:

| Error | Action |
| --- | --- |
| Under 40 ms | None |
| 40 ms to 500 ms | Adjust the playback rate by `clamp(error / 2 s, −5%, +5%)` until the error is under 40 ms, then return to 1 |
| Over 500 ms | Frame-exact seek to the target position |

### Commands

- **Play and pause:** the source publishes a control record with `atUs` set **500 ms in the future**. Each peer converts `atUs` to its own clock and hands it to the engine's **scheduled play or pause**, which the engine's media clock carries out at that moment. No Snowy timer is involved, and the engine's `started` or `paused` event confirms it.
- **Seek:** the source publishes the new record with `atUs` 500 ms ahead, and moves the target chunks to the front of its queue. A peer that already holds the target hands the engine a scheduled seek and play at `atUs`. A peer that doesn't seeks as soon as the first target chunk is stored, straight to the position computed from the record. Nobody waits for anybody.

### While the source is offline

- Peers keep following the last control record from their own stores.
- A peer whose next chunk is missing pauses **locally** and shows *Waiting for source*. When that chunk is stored, it seeks to the computed position and carries on.
- When the source comes back, it publishes a new control record with a higher epoch. Every peer follows it.

## Audio and subtitle choice

- **Audio:** each peer picks any audio track in the catalog. Its `caps.audio` tells the source to push that track. Switching:
  1. The peer updates `caps.audio`.
  2. It requests the new track's chunks from the playhead onwards, through the normal [choice of source](#choosing-where-each-chunk-comes-from).
  3. It switches the engine's audio track when the chunk at the playhead is stored.
- **Subtitles:** every subtitle track is pushed to every peer within its storage window. Switching or turning them off is local and immediate, with nothing sent over the network.
- All tracks share one timeline, so each peer's choices line up with the control record.

## Chat

### Message

```ts
type ChatMessage = {
  author: PeerId;
  seq: number;              // 1, 2, 3, … per author, kept in the local store
  prev: string;             // SHA-256 of the author's previous message, or "" for seq 1
  hlc: string;              // hybrid logical clock: 16 hex digits, wall ms (48 bits) then counter (16 bits)
  mediaUs: number;          // the sender's playhead when sending
  kind: "text" | "edit" | "delete" | "react";
  target?: { author: PeerId; seq: number };   // the message an edit, delete or reaction applies to
  text?: string;            // text and edit
  emoji?: string;           // react
};
```

### Order

- Every peer sorts messages by `(hlc, author)`, so every peer shows the same order. The HLC is fixed-width, so comparing it as a string compares it as a number.
- The HLC moves forward on every message sent and every message received. A reply therefore always sorts after the message it answers.
- A message that arrives after later ones (because it was written offline) goes into its sorted position and is marked *arrived late*.

### Edits, deletes and reactions

Chat stays append-only:

- An edit, a delete or a reaction is a **new message** whose `target` names an earlier one, by any author.
- Only the author of a message may edit or delete it. Peers ignore edits and deletes whose `author` differs from `target.author`.
- The latest edit by `(hlc, author)` wins. A delete hides the target and every edit of it.
- Reactions are kept per `(reactor, target, emoji)`. A `react` message with an `emoji` adds it, and one with the same `emoji` and `text: ""` removes it. The latest message for each key wins.

### Sending

- A message is written to the local log first, then sent on `peer/<self>/chat`.
- While the relay stream is busy, new messages queue. When it's free, everything queued goes as one batch object. Batching therefore follows network speed, not a clock.
- Offline, messages queue in the log and are sent when the reconnect event fires.

### Gaps and repair

- A gap is noticed locally: receiving `A:n` while the newest stored `A` message is below `n − 1`.
- **The peer that has the gap chooses who to ask:** the candidates are the author (if online) and its connected group peers, ranked by `SHA-256(candidate ‖ author ‖ firstMissingSeq)`. It asks the lowest one, then the next if the answer is `gone` or the link closes.
- The answer goes only to the peer that asked, on `inbox/<requester>/deliver/<responder>` or over the direct `ctl` channel.
- **On reconnect**, a peer sends its version vector `{ author: newestSeq }` once to the first candidate, who replies with every message it holds beyond that.
- There is no gossip when nothing is missing.

### Authenticity

- Messages arriving on the author's own track are authenticated by the relay's permissions.
- Every message's `prev` hash links it to the author's previous one, forming a chain.
- When the author's send queue empties, it publishes a **checkpoint** `{ author, seq, head: SHA-256(message seq), sig }` signed with its peer key.
- A message received through repair is shown only after its chain checks out against a checkpoint. Until then it's held unshown.

### Display

Message text is rendered with `textContent` only.

## Presence and membership

- **Joining:** a peer is online once its `peer/<PeerId>` namespace is announced on the relay. Peers learn of it through their namespace subscription.
- **Leaving:** the namespace's withdrawal, or the link's `close` event, marks a peer offline. There are no heartbeats.
- **Getting current state on join** (the relay holds none): the joiner asks for `catalog`, `control`, `init/*` and the forwarders' capability records from the source if it's online. Otherwise it asks the online peer with the lowest `SHA-256(peer ‖ "state")`, and the next one on `gone` or `close`. Every record is signed, so it can come from any peer.

## Events

Every action in the system responds to one of these events:

| Event | Source | Reaction |
| --- | --- | --- |
| `announce(peer)` / `unannounce(peer)` | Relay | Update presence. Plan or drop links. |
| `link open` / `link close` | WebTransport, WebRTC | Start or stop requesting through the link. Retry its requests elsewhere. |
| `writable` | Writer `ready`, `bufferedamountlow` | Send the next queued object or batch |
| `delivery done` | Link | Mark the request done. Update measured upload and RTT. |
| `stored(key)` / `deleted(key)` | Store | Batch a `have` update. Resume playback after waiting. |
| `progress(t)` | Engine media clock | Urgent window, storage window, drift correction |
| `started` / `paused` | Engine | Confirm a scheduled command |
| `control(record)` | `source/control` | Schedule play, pause or seek at `atUs` with the engine |
| `catalog(version)` | `source/catalog` | Update the tracks and bitrates shown |
| `caps(record)` | `peer/*/caps`, the source's inbox | Candidate forwarders, audio tracks to push, slot counts |
| `have(ranges)` | `peer/*/have`, `ctl` | Plan chunk requests |
| `request` / `cancel` / `busy` / `gone` | `inbox`, `ctl` | Serve, stop, or try the next source |
| `chat(batch)` | `peer/*/chat` | Store, sort, detect gaps |
| `probe received` | `peer/<self>/probe` | Set measured upload. Re-check whether to forward. |
| `visibilitychange` | Document | Re-check whether to forward |
| `setting change` | User | Re-check whether to forward, probing first if sharing was turned on. Audio choice. Subtitle choice. |
| `ice failed` | WebRTC | Mark the pair relay-only |

The transports' keepalives and idle timeouts (QUIC's idle timeout, WebRTC's connection-freshness checks) and the engine's media clock are the only clocks in the system. They arrive as `link close`, `progress`, `started` and `paused` events.

## The relay

### Behaviour

- Forwards every object to its current subscribers and to whoever it was addressed to, then forgets it.
- Keeps no cache, no history and no latest value. It has no timers of its own beyond QUIC's.
- **After a restart:** every peer gets `link close`, reconnects, re-announces and republishes its current capability record and `have`. The source republishes `catalog` and `control`. No data is lost, because peers hold all of it.

### Authorization

| Who | May publish | May subscribe |
| --- | --- | --- |
| Source `S` (token signed by the session key and `S`'s peer key) | `source/*`, plus everything peer `S` may publish | Everything |
| Peer `P` (join grant plus a request signed by `P`) | `peer/P/*`, `inbox/*/P`, `inbox/*/deliver/P` | `source/*`, `peer/*/caps`, `peer/*/chat`, `peer/*/have`, `peer/P/probe`, `inbox/P/*` |

The relay checks the signatures once per connection.

## Security

| Threat | Protection |
| --- | --- |
| The relay or an outsider reading content | All objects are encrypted with AES-GCM under a key derived from the session secret, which lives only in the URL fragment. Every encryption uses a fresh random nonce. |
| A peer forging media | Chunk headers are signed by the session key, and the body hash is checked before storing |
| A peer forging capability records | Records are signed by the peer key |
| A peer forging chat while repairing gaps | Author hash chains plus signed checkpoints |
| A peer posting as someone else | Relay authorization: only `P` can publish `peer/P/*` |
| A viewer controlling playback | Only the source can publish `source/*`, and control records are signed |
| Script injection through chat | `textContent` only |
| Keys being read out of the store | Private keys are non-extractable `CryptoKey`s |
| Content left on devices | The session's store is deleted on [leave or end](#session-lifecycle), and on the next app start after a crash |

## Session lifecycle

| Step | What happens |
| --- | --- |
| **Create** | The source picks a file, generates the session key, its peer key and the secret, signs a join grant, demuxes enough to write `catalog` and `init/*`, connects to the relay, and shows the invite link. |
| **Join** | A peer opens the link, generates its peer key, connects with grant plus signed request, announces itself, gets state from the source or a peer, asks the user about Share my upload, assesses itself, publishes its capability record, measures its clock offset, joins groups, and starts filling its storage window. |
| **Watch** | Driven entirely by the [events](#events) above |
| **Source drops** | Peers play from their stores and pause locally on a missing chunk. Chat carries on. |
| **Relay drops** | Playback continues from local stores. Chat queues locally. Everything resumes on reconnect. |
| **Leave** | The peer closes its links. Its namespace is withdrawn. Its session store (OPFS directory and IndexedDB keys) is deleted. |
| **End** | The source publishes control with `ended: true`. Every peer stops playback, closes its links and deletes its session store. |
| **App start** | Every session store is deleted except the one whose invite link is being opened, which carries on where it left off. |

## Requirements on @snowy-media/engine

The sync package needs these engine capabilities through public exports:

| Capability | Used for |
| --- | --- |
| **A pluggable packet source**: play from codec setup plus packet records supplied by the caller, not a `File` | Playing chunks from the store |
| **Demuxer access at the source**: read packets and track info from a `File` | Cutting chunks |
| **Choosing the audio track**, including while playing | Per-viewer audio |
| **Subtitle rendering**: text (SRT, ASS) and bitmap (PGS), with the track chosen while playing | Per-viewer subtitles |
| **Scheduled play, pause and seek** at a given wall-clock time, carried out by the media clock, with `started` and `paused` events | Commands that every peer applies at the same moment |
| **Playback rate** within ±5%, with the audio resampled | Drift correction |
| **`progress` events** from the media clock | The scheduler, drift correction |
| **Frame-exact `seek`** | Seeks and large drift |
| **Discarding frames before a start time** when decoding begins at a chunk | Open-GOP chunks |

## Constants

| Constant | Value |
| --- | --- |
| Minimum video chunk length | 2 s, closed at the next keyframe |
| Urgent window | Playhead to playhead + 30 s |
| Storage window (default) | 2 min behind to 15 min ahead |
| Command lead time (`atUs` ahead of now) | 500 ms |
| Drift: ignore / adjust rate / seek | < 40 ms / 40–500 ms / > 500 ms |
| Maximum rate adjustment | ±5% |
| Clock-sync exchanges | 5, sent one after another |
| Upload probe | 1 s of session bitrate, at most 2 MB |
| Share of upload offered as slots | 60% |
| Forwarder: start / stop | Upload ≥ 1.67× / < 1× the session bitrate |
| Forwarders tried / kept per receiver | 8 / 4 |
| Data channel message size | At most 64 KiB, header included |
| Data channel buffer: pause / resume | 1 MiB / 256 KiB |
| AES-GCM nonce | 96 random bits per encryption |
| HLC layout | 16 hex digits: 48-bit wall ms, then 16-bit counter |

## Limits

- **Networks that block UDP** can't join. WebTransport and WebRTC both need UDP, and there is no TURN.
- **No transcoding.** Every peer must be able to decode the catalog's codecs. When a peer joins, it checks each track with `VideoDecoder.isConfigSupported` / `AudioDecoder.isConfigSupported` and refuses to join with an error naming the codec.
- **One source per session.** If the source leaves for good, the session can't continue beyond what peers already hold.
- **The relay is on the live path.** While it's down, playback continues from local stores but nothing new arrives.
- **Peer upload is opt-in.** Sessions where nobody forwards are served entirely through the relay.
- **Join grants don't expire and can't be revoked.** Anyone holding the invite link can join for as long as the session runs.
- **Chunk length follows the file.** A file with long keyframe intervals makes long, large video chunks.
