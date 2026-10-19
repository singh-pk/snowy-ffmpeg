# Architecture

How @snowy-media/engine is built and why. For using it, start with the [README](../README.md).

## One platform

The engine assumes one platform baseline and has exactly one code path for it:

| Feature | Used for |
| --- | --- |
| Cross-origin isolation | `SharedArrayBuffer` between threads, WebAssembly threads |
| WebAssembly SIMD and threads | `@snowy-media/ffmpeg` |
| AudioWorklet | audio output, and the clock everything else follows |
| `OffscreenCanvas` | drawing from a worker, so the main thread never touches a frame |
| WebGPU in a worker | drawing frames: colour conversion and compositing in one pass |
| WebCodecs | hardware video decoding where the browser offers it |
| `importExternalTexture` of a `VideoFrame` | drawing a decoded frame without copying it |

`createEngine` checks all of them once, before it starts anything, and rejects with an `UnsupportedPlatformError` whose `feature` names the first one missing. The main thread checks what it can see (`src/platform.ts`); the render worker checks WebGPU, WebCodecs and texture import itself, because only a real worker with a real canvas shows whether they work there. Nothing else in the engine checks for features, so there are no partial modes to test or maintain.

The WebGPU check asks for an adapter, a device and a canvas context and then imports a 2×2 `VideoFrame`, rather than testing that `navigator.gpu` exists: browsers expose `navigator.gpu` and then return no adapter when WebGPU is blocklisted or disabled, and a browser can have WebGPU without being able to import frames in a worker.

## Threads

| Thread | Does | Blocks |
| --- | --- | --- |
| Main | the API, starting and stopping workers | never |
| Render worker | WebGPU, WebCodecs | never |

Each worker is an entry point of its own in `dist/`, loaded by URL, so a thread downloads only its own code.

## Testing

The tests run the engine in Chromium, Firefox and WebKit through Playwright, with a GPU, because WebGPU on a software renderer would leave the code real users run untested. That decides where they run:

| Runner | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| macOS 26 (CI) | yes, with `--enable-gpu` | yes, with a window | yes |
| macOS 15 | yes | yes, with a window | no WebGPU |
| Linux | software renderer only | no WebGPU | no WebGPU |

So CI runs the engine tests on `macos-26`. The checks that a browser can be made to fail have a test where they do: a page without cross-origin isolation in every browser, and WebGPU switched off in Chromium and Firefox (WebKit has no switch).
