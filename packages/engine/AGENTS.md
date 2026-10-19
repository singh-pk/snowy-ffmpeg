# Agent guide: @snowy-media/engine

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths and commands below are relative to `packages/engine/`.

This package is the playback pipeline of Snowy, without any user interface: it reads a file, demuxes and decodes it, keeps audio and video in sync and draws into a canvas. The player and the editor build on it. Read [docs/architecture.md](docs/architecture.md) before changing it.

## Commands

| Task | Command |
| --- | --- |
| Bundle `src/` into `dist/` | `bun run build` |
| Build, then the browser tests (Chromium, Firefox, WebKit) | `bun run test` |

The tests need WebGPU with a GPU, so they run on macOS (as CI does) or Windows. On Linux only Chromium has it. Firefox runs with a window, because it has no WebGPU when headless.

## Map

| Path | What it holds |
| --- | --- |
| `src/index.ts` | the public API |
| `src/platform.ts` | the platform check on the main thread, and `UnsupportedPlatformError` |
| `src/render.worker.ts` | the render worker: WebGPU and WebCodecs |
| `src/protocol.ts` | the messages between threads |
| `scripts/build.ts` | bundles each thread's entry point into `dist/` |
| `test/` | Playwright tests |
| `docs/architecture.md` | design and the reasons behind it |

## Rules

1. **Know which thread you are on.** Each thread has one job and its own entry point in `scripts/build.ts`. The main thread and the render worker never block. A worker file ends in `.worker.ts` and is typechecked against the worker globals (`tsconfig.worker.json`).
2. **The platform check is the only feature check.** A new requirement is a new `PlatformFeature`, checked in `src/platform.ts` or the render worker. Code elsewhere assumes the baseline and never tests for a feature.
3. **No allocation per frame or per packet.** Hot paths reuse buffers, shared rings and GPU textures that are allocated once.
4. **Queues are bounded by bytes,** never by an item count, so memory stays bounded at any resolution.
5. **No runtime dependencies** besides `@snowy-media/ffmpeg`.
