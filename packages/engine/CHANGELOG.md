<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `createEngine({ canvas })`, which checks the platform once and rejects with an `UnsupportedPlatformError` naming the first missing feature: cross-origin isolation, WebAssembly SIMD or threads, AudioWorklet, OffscreenCanvas, WebGPU in a worker, WebCodecs, or importing a `VideoFrame` as a WebGPU texture.
