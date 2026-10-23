# Agent guide: @snowy-media/sync

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths below are relative to `packages/sync/`.

This package runs watch-together sessions: a local file streamed from one source to a group, with shared chat and per-viewer audio and subtitles. It plays through `@snowy-media/engine`, using only its public exports. Read [docs/architecture.md](docs/architecture.md) before changing it; code follows that design, and a change to the design changes that document in the same pull request.

## Commands

| Task | Command |
| --- | --- |
| Tests (Bun) | `bun run test` |
| Typecheck | `bun run typecheck` |

## Map

| Path | What it holds |
| --- | --- |
| `src/crypto.ts` | key pairs and key ids, Ed25519 signatures, the content key, and sealing objects with AES-GCM |
| `src/chunk.ts` | the media chunk: its signed header and packet records, encoded and checked |
| `test/` | Bun tests; `test/support/` holds what they share |

## Rules

1. **Event-driven only.** No `setTimeout` or `setInterval`, and no polling. Every action responds to a transport, engine, store or user event; the transports' keepalives are the only clocks.
2. **One writer per object.** Never add an object that two peers write.
3. **The relay stores nothing.** Never rely on it keeping an object after forwarding it.
4. **Transports stay behind `Link`.** The scheduler, the store and chat never refer to MoQ or WebRTC directly.
