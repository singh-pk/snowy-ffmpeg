# snowy-ffmpeg

[![ci](https://github.com/singh-pk/snowy-ffmpeg/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-ffmpeg/actions/workflows/ci.yml)
[![REUSE compliant](https://img.shields.io/badge/REUSE-compliant-green)](https://reuse.software)
[![License: LGPL-2.1-or-later](https://img.shields.io/badge/license-LGPL--2.1--or--later-blue)](LICENSES/LGPL-2.1-or-later.txt)
[![FFmpeg 9.0.2](https://img.shields.io/badge/FFmpeg-9.0.2-green)](https://ffmpeg.org)

FFmpeg 9 compiled to WebAssembly as small, lazily loaded modules for playing and editing video in the browser. It powers [Snowy](https://github.com/singh-pk/snowy).

- **Every format.** The `core` module opens every single-file container FFmpeg knows (350 demuxers) and decodes every audio and subtitle codec.
- **Fast.** It demuxes a 750 MB 1080p file in 0.25–1 s in Chromium, Firefox and WebKit alike, where other browser demuxers slow down by up to 100× in some engines ([benchmarks](bench/README.md)).
- **Exact.** Every fixture demuxes to the same streams, packets and timestamps as native `ffprobe`.
- **Reproducible.** Pinned, checksummed and GPG-verified sources; CI checks that the output is byte-identical.

> [!NOTE]
> Pre-release. The `core` module works; video decoding and muxing modules are in development, and nothing is published to npm yet.

## What it is, and isn't

- **It is** FFmpeg's libraries (demuxing and decoding) as WebAssembly modules that JavaScript calls directly, reading files through a worker's `FileReaderSync` instead of a virtual filesystem.
- **It isn't** the `ffmpeg` command line in a browser. For that, use [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

## Requirements

A [cross-origin isolated](https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated) page (COOP + COEP headers) in a browser with WebAssembly SIMD and threads: current Chromium, Firefox and Safari. Modules run in a dedicated worker.

## Usage

```js
// In a module worker on a cross-origin isolated page.
import { AVERROR_EOF, AVSEEK_SIZE, createCore } from "./dist/core/index.js";

const ready = createCore(); // start loading now; awaited per message so none is lost
const reader = new FileReaderSync();
let file;
let pos = 0;

const core = await ready;

// FFmpeg reads through these two hooks.
core.snyRead = (_io, buf, size) => {
  const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, pos + size)));
  core.HEAPU8.set(bytes, buf);
  pos += bytes.length;
  return bytes.length; // 0 means end of file
};
core.snySeek = (_io, offset, whence) => {
  if (whence === AVSEEK_SIZE) return BigInt(file.size);
  pos = [0, pos, file.size][whence] + Number(offset);
  return BigInt(pos);
};

self.onmessage = ({ data: input }) => {
  file = input; // a File from <input type=file> or drag and drop
  pos = 0;
  const out = core._malloc(4);
  const err = core._sny_open(1, 4 << 20, out); // 4 MiB read buffer
  const ctx = core.HEAP32[out >> 2];
  core._free(out);
  if (err < 0) throw new Error(core.UTF8ToString(core._sny_strerror(err)));
  core._sny_find_stream_info(ctx);

  const pkt = core._sny_packet_alloc();
  let ret;
  while ((ret = core._sny_read(ctx, pkt)) >= 0) {
    const start = core._sny_packet_data(pkt);
    const bytes = core.HEAPU8.subarray(start, start + core._sny_packet_size(pkt));
    // Hand `bytes` for stream core._sny_packet_stream(pkt) to WebCodecs or a decoder.
  }
  if (ret !== AVERROR_EOF) console.error(core.UTF8ToString(core._sny_strerror(ret)));
  core._sny_packet_free(pkt);
  core._sny_close(ctx);
};
```

Every `_sny_*` call that can fail returns a negative AVERROR code, and `_sny_strerror` describes it. The full API is [`src/helpers.c`](src/helpers.c); `dist/core/index.d.ts` types every function and constant. [docs/architecture.md](docs/architecture.md) explains the design.

## Modules

| Module | Contents | Status |
| --- | --- | --- |
| `core` | every single-file demuxer, every parser, every audio and subtitle decoder | available |
| `video` | common software video decoders, dav1d, swscale | in development |
| `video-ext` | the remaining FFmpeg video decoders | in development |
| `mux` | muxers and audio encoders | in development |

## Building

Requires Docker with buildx, and [Bun](https://bun.sh).

```sh
bun install
bun run build   # dist/core/{core.js,core.wasm,index.js,index.d.ts}
bun test        # Chromium, Firefox, WebKit (run `bunx playwright install` once)
```

## Contributing

Issues and pull requests are welcome, from people and from AI agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; agents start at [AGENTS.md](AGENTS.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Acknowledgements

snowy-ffmpeg grew out of [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) by Jerome Wu and contributors, whose Docker-based Emscripten build showed the way. [libav.js](https://github.com/Yahweasel/libav.js) and [web-demuxer](https://github.com/bilibili/web-demuxer) are prior art for module variants and demux-only builds. And of course [FFmpeg](https://ffmpeg.org) itself.

## License

[LGPL-2.1-or-later](LICENSES/LGPL-2.1-or-later.txt), like FFmpeg. [NOTICE](NOTICE) lists the bundled third-party code and its licences.
