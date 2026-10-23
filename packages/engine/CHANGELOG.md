<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `createEngine({ canvas })`, which checks the platform once and rejects with an `UnsupportedPlatformError` naming the first missing feature: cross-origin isolation, WebAssembly SIMD or threads, AudioWorklet, OffscreenCanvas, WebGPU in a worker, WebCodecs, or importing a `VideoFrame` as a WebGPU texture.
- `engine.open(file)`, which reads a local `File` in a worker and resolves with its container format, duration and tracks: codec, plus size for video and sample rate and channels for audio. It clears the canvas to black, so nothing of the file before stays on screen.
- `engine.play()`, `engine.pause()` and `engine.currentTime`: the open file's first video and first audio track play in sync, with the frame on screen the one due at the time being heard. Video demuxes ahead of the audio, so the last frames of sparse video, or of video that ends before the audio, show on time. Files without audio do not play yet.
- `engine.seek(time)`, which goes to the frame due at `time`, exactly, paused or playing, with the clock at `time` to the sample.
- `engine.fastSeek(time)`, for scrubbing: called on every pointer move, the screen follows as fast as it decodes, decoding on through frames instead of starting again where it can, and lands on the frame due at the last `time`.
