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

[Unreleased]: https://github.com/singh-pk/snowy-ffmpeg/commits/main
