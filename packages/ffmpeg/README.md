# \-media/ffmpeg

[![ci](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml/badge.svg)](https://github.com/singh-pk/snowy-media/actions/workflows/ci.yml)
[![REUSE compliant](https://img.shields.io/badge/REUSE-compliant-green)](https://reuse.software)
[![License: LGPL-2.1-or-later](https://img.shields.io/badge/license-LGPL--2.1--or--later-blue)](https://github.com/singh-pk/snowy-media/blob/main/LICENSES/LGPL-2.1-or-later.txt)
[![FFmpeg 9.0.2](https://img.shields.io/badge/FFmpeg-9.0.2-green)](https://ffmpeg.org)

FFmpeg 9 compiled to WebAssembly as small, lazily loaded modules for playing and editing video in the browser. It is the media engine of [Snowy](https://github.com/singh-pk/snowy-media).

- **Every format.** The `core` module opens every single-file container FFmpeg knows (350 demuxers) and decodes every common audio codec and every subtitle codec. Video is decoded by `video` (H.264, HEVC, VP9, AV1 through dav1d, ProRes, MPEG-2 and the other codecs real files use) and the remaining codecs by `video-ext` and `audio-ext`, each loaded only when a file needs it.
- **Fast.** It demuxes a 750 MB 1080p file in 0.25–1 s in Chromium, Firefox and WebKit alike, where other browser demuxers slow down by up to 100× in some engines ([benchmarks](bench/README.md)).
- **Exact.** Every fixture demuxes to the same streams, packets and timestamps as native `ffprobe`, and decodes to the same audio and the same video frames, byte for byte, as native `ffmpeg`.
- **Reproducible.** Pinned, checksummed and GPG-verified sources; CI checks that the output is byte-identical.

> [!NOTE]
> Pre-release: nothing is published to npm yet, and until 1.0 a minor version may change the API. The demuxing and decoding modules work; the muxing module is in development.

## What it is, and isn't

- **It is** FFmpeg's libraries (demuxing and decoding) as WebAssembly modules that JavaScript calls directly, reading files through a worker's `FileReaderSync` instead of a virtual filesystem.
- **It isn't** the `ffmpeg` command line in a browser. For that, use [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

## Install

```sh
npm install @snowy-media/ffmpeg
```

Each module is its own entry point: `@snowy-media/ffmpeg/core`, `/audio-ext`, `/video` and `/video-ext`, typed by its `index.d.ts`. A module loads its `.wasm` and starts its threads from the URL of its own `.js` file (`import.meta.url`), so serve the two side by side, unchanged. With Vite, add `optimizeDeps: { exclude: ["@snowy-media/ffmpeg"] }`: its development server otherwise moves the `.js` away from its `.wasm`. Every release is published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), from a build byte-identical to `dist.sha256`, and its GitHub release attaches the complete source ([NOTICE](NOTICE)).

## Requirements

A [cross-origin isolated](https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated) page (COOP + COEP headers) in a browser with WebAssembly SIMD and threads: current Chromium, Firefox and Safari. Modules run in a dedicated worker.

## Usage

```js
// In a module worker on a cross-origin isolated page.
import { AVERROR_EOF, AVSEEK_SIZE, createCore } from "@snowy-media/ffmpeg/core";

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
  const name = core.stringToNewUTF8(file.name); // the extension identifies some raw formats
  const err = core._sny_open(1, 4 << 20, name, out); // 4 MiB read buffer
  const ctx = core.HEAP32[out >> 2];
  core._free(name);
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

### Decoding audio

Audio decodes to 32-bit float planar, the format Web Audio uses. Open a decoder for a stream, send it that stream's packets, and take the frames:

```js
const out = core._malloc(4);
const opened = core._sny_decoder_open(ctx, stream, out);
const dec = core.HEAP32[out >> 2];
core._free(out);
if (opened < 0) throw new Error(core.UTF8ToString(core._sny_strerror(opened)));
const swr = core._sny_converter_alloc();
const frame = core._sny_frame_alloc();
const fltp = core._sny_frame_alloc();

// For each packet of the stream, and once more with 0 at the end to drain:
core._sny_decoder_send(dec, pkt);
while (core._sny_decoder_receive(dec, frame) >= 0) {
  if (core._sny_to_float_planar(swr, frame, fltp) < 0) break;
  const n = core._sny_frame_samples(fltp);
  for (let c = 0; c < core._sny_frame_channels(fltp); c++) {
    const plane = core._sny_frame_plane(fltp, c) >> 2;
    const samples = core.HEAPF32.subarray(plane, plane + n); // copy out before the next frame
  }
}

// When done:
core._sny_frame_free(fltp);
core._sny_frame_free(frame);
core._sny_converter_free(swr);
core._sny_decoder_close(dec);
```

`_sny_decoder_open` returns `AVERROR_DECODER_NOT_FOUND` for a long-tail codec (ATRAC, RealAudio, speech codecs and the like): decode it with `audio-ext` instead. [`test/support/decoder.js`](test/support/decoder.js) is the complete loop, including the case where the decoder is full and handing a stream to another module. Integer decoders produce exactly what native FFmpeg does; float decoders match within 10⁻⁶.

### Decoding video

Video decoders live in `video` and `video-ext`; `core._sny_codec_module(ctx, stream)` names the one a stream needs, so a page loads only that. Copy the stream's codec parameters across with `_sny_params_export` and open the decoder with `_sny_decoder_open_params(buf, size, threads, out)` on up to one thread per core, at most 8: the module's thread pool, shared by every decoder open in it; then copy each packet across with `_sny_packet_make`, and run the same send/receive loop as for audio. [`test/support/decoder.js`](test/support/decoder.js) does all of it.

Each decoded frame becomes a WebCodecs `VideoFrame` with one copy out of the WASM heap:

```js
import { createVideo } from "@snowy-media/ffmpeg/video";

const video = await createVideo();
const sws = video._sny_scaler_alloc();
const out = video._sny_frame_alloc();

// For each frame the decoder returns:
if (video._sny_to_video_format(sws, frame, out) < 0) throw new Error("convert");
const size = video._sny_frame_pack_size(out);
const dst = video._malloc(size);
video._sny_frame_pack(out, dst, size);
const picture = new VideoFrame(video.HEAPU8.slice(dst, dst + size), {
  format: video.UTF8ToString(video._sny_frame_video_format(out)), // "I420", "NV12", "RGBA", …
  codedWidth: video._sny_frame_width(out),
  codedHeight: video._sny_frame_height(out),
  timestamp: Number(video._sny_rescale(video._sny_frame_pts(out), tbNum, tbDen, 1, 1_000_000)),
});
video._free(dst);
```

`_sny_to_video_format` passes a frame through untouched when Chromium, Firefox and WebKit all accept its pixel format, and otherwise converts it with libswscale (10-bit to 8-bit, 4:2:2 and 4:4:4 to I420 or RGB). The decoder's own frame stays available, planes and all, through `_sny_frame_data` and `_sny_frame_linesize`, for a WebGL or WebGPU renderer that wants full precision. Every decoder produces exactly what native FFmpeg does.

Every `_sny_*` call that can fail returns a negative AVERROR code, and `_sny_strerror` describes it. The full API is in [`src/`](src): [`demux.c`](src/demux.c), [`decode.c`](src/decode.c), [`audio.c`](src/audio.c), [`video.c`](src/video.c) and [`common.c`](src/common.c); `dist/core/index.d.ts` types every function and constant. [docs/architecture.md](docs/architecture.md) explains the design.

## Modules

| Module | Contents | Status |
| --- | --- | --- |
| `core` | every single-file demuxer, every parser, every common audio decoder, every subtitle decoder | available |
| `audio-ext` | the long-tail audio decoders (speech, game, legacy and niche lossless codecs) | available |
| `video` | the video decoders real files use (H.264, HEVC, VP8, VP9, AV1 through dav1d, MPEG-1/2/4, VC-1, ProRes, DNxHD, MJPEG, …), libswscale | available |
| `video-ext` | every other FFmpeg video decoder (images, screen capture, game and legacy codecs), libswscale | available |
| `mux` | muxers and audio encoders | in development |

## Building

Requires Docker with buildx, and [Bun](https://bun.sh).

```sh
bun install
bun run build   # dist/<module>/ for each module: module .js, .wasm, index.js, index.d.ts
bun test        # Chromium, Firefox, WebKit (run `bunx playwright install` once)
```

## Contributing

Issues and pull requests are welcome, from people and from AI agents. Read [CONTRIBUTING.md](https://github.com/singh-pk/snowy-media/blob/main/CONTRIBUTING.md) first; agents start at [AGENTS.md](AGENTS.md). To report a vulnerability, see [SECURITY.md](https://github.com/singh-pk/snowy-media/blob/main/SECURITY.md).

## Acknowledgements

It grew out of [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) by Jerome Wu and contributors, whose Docker-based Emscripten build showed the way. [libav.js](https://github.com/Yahweasel/libav.js) and [web-demuxer](https://github.com/bilibili/web-demuxer) are prior art for module variants and demux-only builds. And of course [FFmpeg](https://ffmpeg.org) itself.

## License

[LGPL-2.1-or-later](https://github.com/singh-pk/snowy-media/blob/main/LICENSES/LGPL-2.1-or-later.txt), like FFmpeg. [NOTICE](NOTICE) lists the bundled third-party code and its licences.
