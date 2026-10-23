# Agent guide: @snowy-media/sync

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths below are relative to `packages/sync/`.

This package runs live sessions over one transport. In a watch session, a local file is streamed from one source to a group, with shared chat and per-viewer audio and subtitles; it plays through `@snowy-media/engine`, using only its public exports. In an edit session, people and agents edit one `@snowy-media/timeline` project, whose objects sync carries as opaque bytes without depending on that package. Read [docs/architecture.md](docs/architecture.md) before changing it; code follows that design, and a change to the design changes that document in the same pull request.

## Commands

| Task | Command |
| --- | --- |
| Tests (Chromium) | `bun run test` |
| Typecheck | `bun run typecheck` |

## Map

| Path | What it holds |
| --- | --- |
| `src/crypto.ts` | key pairs and key ids, Ed25519 signatures, the content key, and sealing objects with AES-GCM |
| `src/chunk.ts` | the media chunk: its signed header and packet records, encoded and checked |
| `src/hlc.ts` | the hybrid logical clock that orders chat |
| `src/chat.ts` | chat messages in canonical bytes, their hash chain, and signed checkpoints |
| `src/chat-log.ts` | the chat log: shared order, gaps, version vectors, and edits, deletes and reactions applied |
| `src/chat-batch.ts` | the chat batch: an author's queued messages and checkpoint, sealed as one object |
| `src/chat-sender.ts` | sending this peer's chat: chaining each message, and batching whenever the stream is free |
| `src/chat-receiver.ts` | receiving chat batches from tracks, repairs and this peer: into the log, the holdings and gap repair |
| `src/chat-holdings.ts` | what a peer holds of each author's chat, one checkpoint per run, to answer repairs and version vectors |
| `src/chat-repairs.ts` | asking for missing chat: one ask per author, moved to the next ranked peer on `gone` or a closed link |
| `src/chat-requests.ts` | the chat repair messages between peers, checked, and the side that answers them |
| `src/chat-store.ts` | chat in the local store: an append-only OPFS log per author, read back after a reload |
| `src/opfs.d.ts` | types for OPFS sync access handles, which TypeScript's DOM library lacks |
| `src/rank.ts` | ranking peers by hash, so every asker picks alike and different questions spread out |
| `test/` | unit tests (`*.unit.ts`), run in Chromium by `unit.test.ts`; `test/support/` holds what they share |

## Rules

1. **Event-driven only.** No `setTimeout` or `setInterval`, and no polling. Every action responds to a transport, engine, store or user event; the transports' keepalives are the only clocks.
2. **One writer per object.** Never add an object that two peers write.
3. **The relay stores nothing.** Never rely on it keeping an object after forwarding it.
4. **Transports stay behind `Link`.** The scheduler, the store and chat never refer to MoQ or WebRTC directly.
