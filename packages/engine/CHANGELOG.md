<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Video in the codecs WebCodecs does not decode, such as MPEG-2, MPEG-4 Part 2, ProRes, DNxHD and FFV1, plays: `@snowy-media/ffmpeg` decodes it in a worker of its own, loading its `video` module, or `video-ext` for rarer codecs, the first time a file needs it.

## [0.1.0] - 2026-10-24

### Added

- `createEngine({ canvas })`, which checks the platform once and rejects with an `UnsupportedPlatformError` naming the first missing feature: cross-origin isolation, WebAssembly SIMD or threads, AudioWorklet, OffscreenCanvas, WebGPU in a worker, WebCodecs, or importing a `VideoFrame` as a WebGPU texture.
- `engine.open(handle)`, which reads the file behind a `FileSystemFileHandle` (from `showOpenFilePicker`, a drop, or IndexedDB once permission is granted again) in a worker and resolves with its container format, duration and tracks: codec, plus size for video and sample rate and channels for audio, or rejects with an `AbortError` if a later open is called first. It clears the canvas to black, so nothing of the file before stays on screen.
- `engine.play()`, `engine.pause()` and `engine.currentTime`: the open file's first video and first audio track play in sync, with the frame on screen the one due at the time being heard. Video demuxes ahead of the audio, so the last frames of sparse video, or of video that ends before the audio, show on time. Files without audio do not play yet.
- `engine.seek(time)`, which goes to the frame due at `time`, exactly, paused or playing, with the clock at `time` to the sample.
- `engine.fastSeek(time)`, for scrubbing: called on every pointer move, the screen follows as fast as it decodes, decoding on through frames instead of starting again where it can, and lands on the frame due at the last `time`.

### Changed

- Supported and tested in current stable desktop Chromium only (Chrome, Edge); Firefox and WebKit are no longer tested or benchmarked.

[Unreleased]: https://github.com/singh-pk/snowy-media/compare/@snowy-media/engine@0.1.0...HEAD
[0.1.0]: https://github.com/singh-pk/snowy-media/releases/tag/@snowy-media/engine@0.1.0
