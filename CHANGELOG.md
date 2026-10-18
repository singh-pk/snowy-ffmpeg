<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `core` module: FFmpeg 9.0.2 with every single-file demuxer, every parser and every audio and subtitle decoder, built with SIMD, threads and LTO.
- A typed JavaScript API generated from `src/helpers.c`: open, stream info, packet reading, seeking and the keyframe index.
- Tests against native `ffprobe` on 37 fixtures in Chromium, Firefox and WebKit.
- A demux benchmark against libav.js and mediabunny, and build-flag variants.
- Reproducible builds, checked in CI.
- Audio decoding in `core`: `sny_decoder_*` (open, send, receive, flush), `sny_frame_*` getters, and `sny_to_float_planar`, which hands every frame to JavaScript as 32-bit float planar. Output matches native FFmpeg 9.0.2 exactly for integer decoders and within 10⁻⁶ for float decoders, and decodes E-AC-3 and TrueHD 5.1 at over 150× real time in Chromium, Firefox and WebKit.
- `HEAPF32` on the module, for reading float planes.

### Changed

- `sny_open` takes the file name, so formats FFmpeg recognises only by extension (raw TrueHD, for one) open.
- `core` includes libswresample: +50 KiB brotli (2.4%).

[Unreleased]: https://github.com/singh-pk/snowy-ffmpeg/commits/main
