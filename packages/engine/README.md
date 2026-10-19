# @snowy-media/engine

[![ci](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/singh-pk/snowy-media/blob/main/LICENSE)

The playback pipeline of [Snowy](https://github.com/singh-pk/snowy-media): it reads a local file, demuxes and decodes it with [`@snowy-media/ffmpeg`](../ffmpeg) and WebCodecs, keeps audio and video in sync, and draws into a canvas with WebGPU, all in workers. It has no user interface; the Snowy player and editor build on it.

> [!NOTE]
> In development and not yet published. So far it checks that the browser can run it.

## Requirements

A page served with cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`) in a browser with WebAssembly SIMD and threads, AudioWorklet, WebGPU on an `OffscreenCanvas` in a worker, and WebCodecs. There is no fallback: where something is missing, `createEngine` says what.

```ts
import { createEngine, UnsupportedPlatformError } from "@snowy-media/engine";

try {
  const engine = await createEngine({ canvas: document.querySelector("canvas")! });
} catch (e) {
  if (e instanceof UnsupportedPlatformError) console.log(`This browser lacks ${e.feature}`);
}
```

## Licence

[MIT](https://github.com/singh-pk/snowy-media/blob/main/LICENSE). `@snowy-media/ffmpeg`, which it loads at run time, is LGPL-2.1-or-later.
