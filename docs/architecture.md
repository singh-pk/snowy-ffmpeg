# Architecture

How snowy-ffmpeg is built and why. For using it, start with the [README](../README.md).

## Requirements

Every module assumes one platform, so each has exactly one code path:

| Requirement | Used for |
| --- | --- |
| Cross-origin isolation (COOP + COEP) | `SharedArrayBuffer` and WebAssembly threads |
| WebAssembly SIMD, threads and bulk memory | every module (`-msimd128 -pthread`) |
| A dedicated worker with `FileReaderSync` | synchronous reads of local files |

There are no single-threaded, non-SIMD or main-thread builds. A page that cannot meet the requirements should say so rather than fall back.

## Modules

FFmpeg is split into modules so a page downloads only what a file needs:

| Module | Contents | Status |
| --- | --- | --- |
| `core` | every single-file demuxer, every parser, every common audio decoder, every subtitle decoder, libswresample, zlib, bzip2 | available |
| `audio-ext` | the long-tail audio decoders: speech, game, legacy and niche lossless codecs (ATRAC, RealAudio, TwinVQ, QDM2, Musepack, G.72x, …), libswresample | available |
| `video` | the video decoders real files use: camera, phone, web, broadcast, disc and editing codecs (H.264, HEVC, VP8, VP9, AV1 through dav1d, MPEG-1/2/4, VC-1/WMV, ProRes, DNxHD, MJPEG, …), libswscale | available |
| `video-ext` | every other FFmpeg video decoder: images, screen capture, game and legacy codecs, libswscale, zlib, bzip2 | available |
| `mux` | muxers and audio encoders | in development |

Network and playlist demuxers (HLS, DASH, RTSP, concat, image sequences) are excluded: they open other URLs, which a page does better itself. The demuxer list lives in [`build/configure.sh`](../build/configure.sh); the decoders are read from FFmpeg's own sources and sorted by their codec's media type, so new FFmpeg codecs are picked up automatically. One list in the same script sends the long-tail audio decoders to `audio-ext`, one names the video decoders of `video` (every other one goes to `video-ext`), and one drops decoders FFmpeg never selects, along with the few FFmpeg builds only under the GPL; together they take `core` from 2.1 MB to 1.3 MB brotli, and a file with a common codec downloads nothing else. Without the decoder, `core`'s stream info for an `audio-ext` codec is what the demuxer and parser report: the sample format, for one, stays unknown until a frame is decoded.

## The JavaScript boundary

The files in [`src/`](../src) are the entire API of the modules: [`common.c`](../src/common.c) is in every module, [`demux.c`](../src/demux.c) only in `core`, [`decode.c`](../src/decode.c) in every module that decodes, [`audio.c`](../src/audio.c) in those that decode audio and [`video.c`](../src/video.c) in those that decode video, as [`sny.h`](../src/sny.h) lists.

- JavaScript never computes an offset into an FFmpeg struct. Every field it needs is a one-line getter, so an FFmpeg upgrade either compiles or fails loudly instead of reading the wrong bytes. Getters inline away under LTO.
- Constants that JavaScript needs are declared with `SNY_CONST`, which `_Static_assert`s the value against FFmpeg's headers.
- [`scripts/gen-dts.ts`](../scripts/gen-dts.ts) generates `index.js` and `index.d.ts` from those declarations. 64-bit values are `bigint`; pointers are a branded `Ptr`.

## I/O

FFmpeg reads through a custom `AVIOContext`. Its callbacks call two JavaScript imports declared in [`src/io.js`](../src/io.js), `Module.snyRead` and `Module.snySeek`, which the caller provides. There is no virtual filesystem (`-sFILESYSTEM=0`) and no function table growth.

For local files the caller reads with `FileReaderSync` in a worker. Each call costs about 0.1 ms whatever its size, so use a large AVIO buffer: 4 MiB demuxes Matroska and MPEG-TS up to 4× faster than 64 KiB and keeps keyframe seeks under 3 ms ([benchmarks](../bench/README.md)).

## Audio

Audio is always decoded by FFmpeg, right after demuxing in the same worker, never by WebCodecs. That gives one code path for every codec (E-AC-3, DTS and TrueHD included), identical output in every browser, and exact sample positions.

- `sny_decoder_open` opens a decoder for a stream. For a codec in `audio-ext` it returns `AVERROR_DECODER_NOT_FOUND`: the caller loads `audio-ext`, copies the stream's codec parameters across with `sny_params_export` and `sny_decoder_open_params`, and copies each packet with `sny_packet_make` and `sny_packet_side_data_add`. Modules don't share memory, so this is the one way a decoder in another module is fed, and the video modules use it too. The stream's coded side data (HDR mastering metadata, a display matrix, Dolby Vision configuration) is copied with the parameters, so decoded frames carry it as they would in `core`.
- `sny_decoder_send` and `sny_decoder_receive` are FFmpeg's send/receive loop, and `sny_decoder_flush` follows a seek. [`test/support/decoder.js`](../test/support/decoder.js) is the reference loop.
- `sny_to_float_planar` hands every frame to JavaScript as 32-bit float planar, the format of Web Audio: one plane of samples per channel, read through `HEAPF32`. A frame that is already float planar (AAC, Opus, AC-3, Vorbis, MP3) is referenced, not copied; others are converted by libswresample with no resampling, so the values are exactly what native FFmpeg produces.
- Decoding is far from the bottleneck: one minute of 5.1 E-AC-3 takes 73–85 ms and TrueHD 320–370 ms, including demuxing ([benchmarks](../bench/README.md#audio-decode)).

## Video

Video is decoded by FFmpeg in `video` or `video-ext`, never in `core`, so a page that only demuxes, or only plays audio, never downloads a video decoder. `sny_codec_module` in `core` names the module for a stream from a table of `video`'s codec IDs that the build generates from `configure.sh`, so the list is written once. Whether to use WebCodecs instead is the player's choice; this module is what plays every codec WebCodecs doesn't, identically in every browser.

- Decoders run on threads: `sny_decoder_open_params` takes the thread count, and the video modules start a pool of one worker per core, up to 8, when they load. FFmpeg starts its decoder threads while opening, and a WebAssembly thread can only start from a worker that already exists, so the decoders open in a module together use at most the pool; asking for more fails to open instead of hanging.
- `sny_codec_module` sends the long tail by media type, so a codec FFmpeg decodes only through an external library or under the GPL (JPEG XL, EVC, a few ADPCM variants) names a module that then can't open it.
- `sny_to_video_format` turns a frame into one `VideoFrame` accepts in Chromium, Firefox and WebKit alike: I420, I420A, NV12, RGBA, RGBX, BGRA or BGRX, at an even size unless RGB. The spec allows more (4:2:2, 4:4:4, 10 and 12 bits), but Firefox and WebKit reject them and Firefox rejects odd sizes in subsampled formats, so those frames go through libswscale once. A frame already in an accepted format is referenced, not copied; 8-bit 4:2:0, nearly every file, never converts. libswscale gets the nearest format, with the deprecated full-range yuvj formats counted as the yuv ones they are, so webcam MJPEG goes to I420, not RGB.
- `sny_frame_pack` copies the planes into one buffer in the layout `VideoFrame` assumes, the one copy out of the WASM heap. The decoder's own frame stays readable plane by plane for a renderer that wants 10-bit precision.
- One thread decodes 1080p H.264, HEVC, VP9 and AV1 at well over 30 frames per second on an Apple M-series laptop; threads multiply that ([benchmarks](../bench/README.md#video-decode)).

## Build

The [`Dockerfile`](../Dockerfile) is the only build path:

- Every source is pinned by version and sha256; the FFmpeg tarball is also GPG-verified against [`keys/ffmpeg-devel.asc`](../keys/ffmpeg-devel.asc). The Emscripten image is pinned by digest.
- One configuration for every module: `-O3 -flto -msimd128 -pthread`. Alternatives were benchmarked and rejected: `-O2`, `-Os` and no-LTO are 5–60% slower with no brotli gain; mimalloc and emmalloc are no faster; `-sGROWABLE_ARRAYBUFFERS=2` slows demuxing in Chromium by up to 45%; Closure saves 4 KB.
- Builds are reproducible. [`dist.sha256`](../dist.sha256) holds the expected hashes and CI checks them on every build, so a change to the output is always a visible diff.

## Tests

[`test/`](../test) opens every fixture in Chromium, Firefox and WebKit and compares the streams, packet counts, first timestamps and a seek back to the start with native `ffprobe` of the same FFmpeg version. It also decodes every audio stream and compares the output with native `ffmpeg`, which runs with assembly off (`-cpuflags 0`) so it executes the same C code: integer audio decoders must match by SHA-256; float decoders must match frame counts and timestamps exactly, and every 127th sample within 10⁻⁶, because native compilers fuse multiply-adds and WebAssembly cannot. 127 shares no factor with frame sizes or channel counts, so the sampled values cover every channel and every part of a frame. Every video stream is decoded on up to 4 threads and must match native `ffmpeg`'s raw output by SHA-256, frame count, first timestamps, size and pixel format (video decoders are exact). Frames `sny_to_video_format` converts must match native libswscale's conversion to the same format by SHA-256, and every frame, converted, must construct a `VideoFrame`. Fixtures are generated by [`scripts/gen-fixtures.ts`](../scripts/gen-fixtures.ts) and are 1 s long so the suite runs in seconds.
