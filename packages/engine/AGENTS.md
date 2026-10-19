# Agent guide: @snowy-media/engine

The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what is specific to this package. Paths and commands below are relative to `packages/engine/`.

This package is the playback pipeline of Snowy, without any user interface: it reads a file, demuxes and decodes it, keeps audio and video in sync and draws into a canvas. The player and the editor build on it. Read [docs/architecture.md](docs/architecture.md) before changing it.

## Commands

| Task | Command |
| --- | --- |
| Bundle `src/` into `dist/` | `bun run build` |
| Browser tests (Chromium, Firefox, WebKit) | `bun run test` |
| Benchmarks | `bun run bench --runs 5` |
| Regenerate the fixtures (needs native FFmpeg 9.0.2) | `bun run fixtures` |

The tests and benchmarks build what they run, and need `@snowy-media/ffmpeg` built first (`bun run build` in `packages/ffmpeg`; CI takes it from the ffmpeg build job). They need WebGPU with a GPU, so they run on macOS (as CI does) or Windows. On Linux only Chromium has it. Firefox runs with a window, because it has no WebGPU when headless.

## Map

| Path | What it holds |
| --- | --- |
| `src/index.ts` | the public API |
| `src/platform.ts` | the platform check on the main thread, and `UnsupportedPlatformError` |
| `src/media.worker.ts` | the media worker: reads and demuxes the file, and decodes and resamples its audio, with the FFmpeg core |
| `src/io.ts` | the media worker's synchronous reads from a `File` |
| `src/ring.ts` | the packet ring between two threads |
| `src/codec.ts` | WebCodecs decoder configs, with the codec string from a stream's configuration record or parameter sets |
| `src/pcm.ts` | the PCM ring from the media worker to the AudioWorklet, and the clock |
| `src/audio.ts` | the audio output on the main thread |
| `src/audio.worklet.ts` | the AudioWorklet: plays the PCM ring and publishes the clock |
| `src/render.worker.ts` | the render worker: WebGPU and WebCodecs |
| `src/protocol.ts` | the messages between threads |
| `scripts/build.ts` | bundles each thread's entry point into `dist/`, or for the tests into `test/dist/` |
| `scripts/gen-fixtures.ts` | builds `test/fixtures` and `expected.json` from native FFmpeg |
| `test/` | Playwright tests; `test/support/` is shared with `bench/`, and `serve.ts` builds and serves the engine for both, and `page.ts` is the code their pages import |
| `bench/` | benchmarks ([README](bench/README.md)) |
| `docs/architecture.md` | design and the reasons behind it |

## Rules

1. **Know which thread you are on.** Each thread has one job and its own entry point in `scripts/build.ts`. The main thread and the render worker never block. A worker file ends in `.worker.ts` and is typechecked against the worker globals (`tsconfig.worker.json`), and the AudioWorklet in `.worklet.ts` against its own (`tsconfig.worklet.json`).
2. **The platform check is the only feature check.** A new requirement is a new `PlatformFeature`, checked in `src/platform.ts` or the render worker. Code elsewhere assumes the baseline and never tests for a feature.
3. **No allocation per frame or per packet.** Hot paths reuse buffers, shared rings and GPU textures that are allocated once.
4. **Queues are bounded by bytes,** never by an item count, so memory stays bounded at any resolution.
5. **No runtime dependencies** besides `@snowy-media/ffmpeg`.
6. **Expected results come from native FFmpeg.** Never hand-write a timestamp or a frame count: add the case to `scripts/gen-fixtures.ts` and regenerate.
7. **Performance is measured** with `bun run bench`, before and after, on the same machine.
