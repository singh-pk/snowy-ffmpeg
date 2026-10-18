<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `core` module: FFmpeg 9.0.2 with every single-file demuxer, every parser and every audio and subtitle decoder, built with SIMD, threads and LTO.
- A typed JavaScript API generated from `src/`: open, stream info, packet reading, seeking and the keyframe index.
- Tests against native `ffprobe` on 37 fixtures in Chromium, Firefox and WebKit.
- A demux benchmark against libav.js and mediabunny, and build-flag variants.
- Reproducible builds, checked in CI.
- Audio decoding in `core`: `sny_decoder_*` (open, send, receive, flush), `sny_frame_*` getters, and `sny_to_float_planar`, which hands every frame to JavaScript as 32-bit float planar. Output matches native FFmpeg 9.0.2 exactly for integer decoders and within 10⁻⁶ for float decoders, and decodes E-AC-3 and TrueHD 5.1 at over 150× real time in Chromium, Firefox and WebKit.
- `HEAPF32` on the module, for reading float planes.
- `audio-ext` module: the long-tail audio decoders (speech, game, legacy and niche lossless codecs), 1.0 MB brotli, loaded only for a file that needs one. `sny_params_export`, `sny_decoder_open_params`, `sny_packet_make` and the `sny_packet_side_data*` functions hand a stream demuxed by `core` to it.

### Changed

- `sny_open` takes the file name, so formats FFmpeg recognises only by extension (raw TrueHD, for one) open.
- `core` includes libswresample: +50 KiB brotli (2.4%).
- `core` no longer includes the long-tail audio decoders, now in `audio-ext`, or decoders FFmpeg never selects because another decodes the same codec (`aac_fixed`, `ac3_fixed`, fixed-point MP3, float MP1/MP2): 1.3 MB brotli instead of 2.1 MB. `sny_decoder_open` returns `AVERROR_DECODER_NOT_FOUND` for those codecs, and their stream info is what the demuxer reports (the sample format is unknown until a frame is decoded).

[Unreleased]: https://github.com/singh-pk/snowy-ffmpeg/commits/main
