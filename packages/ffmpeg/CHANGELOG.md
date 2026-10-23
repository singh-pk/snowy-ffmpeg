<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `sny_resample`, with `sny_resampler_alloc`, `sny_resampler_flush` and `sny_resampler_free`: resamples and mixes decoded audio for an `AudioContext`, to 32-bit float with the channels interleaved, at any rate, as mono, stereo, quad or 5.1 in the Web Audio API's channel order. Output matches native `ffmpeg -ar -ac` within 10⁻⁶, honouring the stream's downmix levels.
- `sny_stream_display_matrix` and `sny_stream_rotation`: a stream's display matrix, from the container, before any decoding.
- `sny_pix_fmt_depth`, `sny_pix_fmt_log2_chroma_w` and `sny_pix_fmt_log2_chroma_h`; `sny_frame_chroma_location`; FFmpeg's names for pixel formats, colour ranges, primaries, transfers, matrices and chroma locations (`sny_pix_fmt_name`, `sny_color_*_name`, `sny_chroma_location_name`).
- `sny_packet_move`: moves a packet, with its side data, into another without copying, so packets can be queued.
- Constants: `AV_CODEC_ID_*` for H.264, HEVC, VP8, VP9 and AV1; `AVCOL_*` and `AVCHROMA_LOC_*` for the colour WebCodecs describes; every `AV_DISPOSITION_*` flag.

### Changed

- Supported and tested in current stable desktop Chromium only (Chrome, Edge); Firefox and WebKit are no longer tested or benchmarked.
- **Breaking:** `sny_to_video_format` passes 4:2:2 and 4:4:4, 10- and 12-bit, and odd-sized frames through untouched in their own `VideoFrame` format (`I422P10`, …), where it converted them to 8-bit I420 or RGB, so a caller gets formats it did not get before; `sny_frame_video_format` names them. Formats that still convert may get a different target: 12-bit with alpha converts to 10-bit with alpha, 16-bit YUV to 12-bit, 4:1:1 to I422 and 4:4:0 to I444; RGB, XYZ and gray of any depth still convert to 8-bit RGB.

### Fixed

- `sny_frame_rotation` truncates the angle as ffprobe does, rather than rounding it, and returns 0 instead of an undefined value for a display matrix with no rotation.

## [0.1.2] - 2026-10-19

### Fixed

- The type declarations parse in TypeScript: `sny_to_float_planar` declared a parameter named `in`, a reserved word.

## [0.1.1] - 2026-10-19

### Fixed

- `sny_decoder_send` and `sny_decoder_receive` return `AVERROR(EINVAL)`, now exported as `AVERROR_EINVAL`, for a subtitle decoder instead of corrupting memory: FFmpeg hands such a decoder an `AVFrame` where it expects an `AVSubtitle`.

## [0.1.0] - 2026-10-18

### Added

- The npm package `@snowy-media/ffmpeg`, one entry point per module, published from CI with provenance from a build byte-identical to `dist.sha256`. It carries the third-party licences in `dist/licenses`; the GitHub release attaches the complete source.
- `core` module: FFmpeg 9.0.2 with every single-file demuxer, every parser and every audio and subtitle decoder, built with SIMD, threads and LTO.
- A typed JavaScript API generated from `src/`: open, stream info, packet reading, seeking and the keyframe index.
- Tests against native `ffprobe` and `ffmpeg` on 62 fixtures in Chromium, Firefox and WebKit.
- A demux benchmark against libav.js and mediabunny, and build-flag variants.
- Reproducible builds, checked in CI.
- Audio decoding in `core`: `sny_decoder_*` (open, send, receive, flush), `sny_frame_*` getters, and `sny_to_float_planar`, which hands every frame to JavaScript as 32-bit float planar. Output matches native FFmpeg 9.0.2 exactly for integer decoders and within 10⁻⁶ for float decoders, and decodes E-AC-3 and TrueHD 5.1 at over 150× real time in Chromium, Firefox and WebKit.
- `HEAPF32` on the module, for reading float planes.
- `audio-ext` module: the long-tail audio decoders (speech, game, legacy and niche lossless codecs), 1.0 MB brotli, loaded only for a file that needs one. `sny_params_export`, `sny_decoder_open_params`, `sny_packet_make` and the `sny_packet_side_data*` functions hand a stream demuxed by `core` to it.
- `video` module: the video decoders real files use (H.264, HEVC, VP8, VP9, AV1 through dav1d 1.5.4, MPEG-1/2/4, VC-1/WMV, ProRes, DNxHD, MJPEG and more) and libswscale, decoding on a pool of up to 8 threads. `video-ext` module: every other FFmpeg video decoder. Output matches native FFmpeg 9.0.2 byte for byte.
- `sny_codec_module` in `core`: the module that decodes a stream, so a page loads only that one.
- Video frames: `sny_frame_*` getters (size, key frame, aspect ratio, colour, rotation, planes, pixel format), `sny_to_video_format`, which hands every frame over in a format `VideoFrame` accepts in Chromium, Firefox and WebKit, and `sny_frame_pack`, which copies it into one buffer for `new VideoFrame`.
- A video decode benchmark (`bun run bench:video`): 1080p H.264, HEVC, VP9 and AV1 by thread count.

### Changed

- `sny_open` takes the file name, so formats FFmpeg recognises only by extension (raw TrueHD, for one) open.
- `core` includes libswresample: +50 KiB brotli (2.4%).
- `sny_decoder_open_params` takes the number of decoding threads, and `sny_params_export` carries the stream's coded side data (HDR metadata, display matrix, Dolby Vision configuration) to the other module.
- `core` is 27 KB brotli larger, for the audio decoders it gains (below).
- Decoders are sorted into modules by their codec's media type instead of their section in FFmpeg's `allcodecs.c`. `core` gains six audio decoders filed elsewhere there (S302M, Speex, RKA, DV audio and the two 8SVX variants); the HDR image decoder moves to `video-ext`. Nine decoders FFmpeg builds only under the GPL (eight ADPCM variants and AHX) are left out of every module, as the LGPL build always did.
- `core` no longer includes the long-tail audio decoders, now in `audio-ext`, or decoders FFmpeg never selects because another decodes the same codec (`aac_fixed`, `ac3_fixed`, fixed-point MP3, float MP1/MP2): 1.3 MB brotli instead of 2.1 MB. `sny_decoder_open` returns `AVERROR_DECODER_NOT_FOUND` for those codecs, and their stream info is what the demuxer reports (the sample format is unknown until a frame is decoded).

[Unreleased]: https://github.com/singh-pk/snowy-media/compare/@snowy-media/ffmpeg@0.1.2...HEAD
[0.1.2]: https://github.com/singh-pk/snowy-media/compare/@snowy-media/ffmpeg@0.1.1...@snowy-media/ffmpeg@0.1.2
[0.1.1]: https://github.com/singh-pk/snowy-media/compare/@snowy-media/ffmpeg@0.1.0...@snowy-media/ffmpeg@0.1.1
[0.1.0]: https://github.com/singh-pk/snowy-media/releases/tag/@snowy-media/ffmpeg@0.1.0
