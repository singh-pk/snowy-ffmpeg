# Architecture

How @snowy-media/engine is built and why. For using it, start with the [README](../README.md).

## One platform

The engine assumes one platform baseline and has exactly one code path for it:

| Feature | Used for |
| --- | --- |
| Cross-origin isolation | `SharedArrayBuffer` between threads, WebAssembly threads |
| WebAssembly SIMD and threads | `@snowy-media/ffmpeg` |
| AudioWorklet | audio output, and the clock everything else follows |
| `OffscreenCanvas` | drawing from a worker, so the main thread never touches a frame |
| WebGPU in a worker | drawing frames: colour conversion and compositing in one pass |
| WebCodecs | hardware video decoding where the browser offers it |
| `importExternalTexture` of a `VideoFrame` | drawing a decoded frame without copying it |

`createEngine` checks all of them once, before it starts anything, and rejects with an `UnsupportedPlatformError` whose `feature` names the first one missing. The main thread checks what it can see (`src/platform.ts`); the render worker checks WebGPU, WebCodecs and texture import itself, because only a real worker with a real canvas shows whether they work there. Nothing else in the engine checks for features, so there are no partial modes to test or maintain.

The WebGPU check asks for an adapter, a device and a canvas context and then imports a 2×2 `VideoFrame`, rather than testing that `navigator.gpu` exists: browsers expose `navigator.gpu` and then return no adapter when WebGPU is blocklisted or disabled, and a browser can have WebGPU without being able to import frames in a worker.

## Threads

| Thread | Does | Blocks |
| --- | --- | --- |
| Main | the API, starting and stopping workers | never |
| Media worker | reading the file, demuxing it, decoding and resampling its audio, all with the FFmpeg core | yes, on reads and on a full packet or PCM ring |
| Render worker | WebGPU, WebCodecs | never |
| AudioWorklet | playing the PCM ring, the clock | never |

Each worker is an entry point of its own in `dist/`, loaded by URL, so a thread downloads only its own code. The engine starts both at once, so the FFmpeg core loads while the render worker checks the GPU.

The media worker is the one thread allowed to block. FFmpeg reads its input through synchronous callbacks, and the worker answers them with `FileReaderSync` (`src/io.ts`), straight from the `File`: FFmpeg reads only what the demuxer asks for, in reads of up to 4 MiB, never the whole file. Copying the file into WebAssembly memory first would cap it at that memory, and asynchronous reads would need Asyncify or JSPI around every FFmpeg call.

## Packet ring

The media worker demuxes ahead of playback into a ring in a `SharedArrayBuffer` (`src/ring.ts`), from which another thread reads the packets: one producer, one consumer, and no message per packet. Each packet is one record, a 32-byte header (stream, flags, pts, dts, duration, size) followed by its bytes, padded to 32 bytes. Each record is copied once into the ring from the WebAssembly heap, and read in place unless it wraps around the end of the ring.

- **Variable-length records that may wrap.** A packet of any size up to the capacity fits, with no space lost at the end of the ring and no size class to tune. The 32-byte alignment keeps every header in one piece. A record that wraps is joined in a buffer the consumer reuses.
- **Positions that only grow.** The write and read positions are 32-bit integers that wrap, and the bytes in use are their difference. Each side writes only its own position, so neither takes a lock.
- **The ring being full is the backpressure.** The producer blocks in `Atomics.wait` until the consumer frees room. The consumer never blocks: it waits with `Atomics.waitAsync`. Each side raises a waiting flag before it checks the other's position, and the other notifies only when that flag is up, so a wake-up is never lost and a busy ring makes no `notify` calls.
- **Ending and closing.** A record with stream `END` follows the last packet, and one with stream `FAILED` ends the packets when the producer fails, so the consumer never waits for packets that will not come; the error itself goes to whoever started the producer. The consumer closes the ring to stop the producer, whose next write returns false; a closed ring holds no packets.
- **Capacity: 8 MiB.** That holds seconds of the highest bitrates a browser plays (4K HEVC at 100 Mbit/s is 12.5 MB a second) and any single packet. Moving packets through the ring takes far less time than decoding them: under 0.5 µs per packet, and over 20 GB/s for large packets. A wake-up takes under 0.2 ms at the 99th percentile in every browser (`bench/run.ts`, the `ring` benchmark).

The tests check the ring between two threads in Bun, and check, in every browser, that the packets of every fixture pass through a 64 KiB ring exactly as native `ffprobe` lists them.

## Audio and clock

The media worker decodes the audio itself, with FFmpeg, as it demuxes, and `sny_resample` converts each frame in one call to what the `AudioContext` plays: its sample rate, stereo or the destination's channels, 32-bit float. The samples go into a second ring (`src/pcm.ts`), and the engine's AudioWorklet (`src/audio.worklet.ts`) plays them from there.

- **The PCM ring** is a `SharedArrayBuffer` of interleaved frames with the same growing positions as the packet ring, and its channel count and rate in its header. The producer blocks while it is full. The AudioWorklet may never block, so it never waits: when the ring runs out, it plays silence for the rest of the render quantum. That is an underrun.
- **The AudioWorklet owns the clock.** After each quantum it publishes the media time of the next frame it will play and the context time that frame plays at, and whether it is playing. A reader's media time is that time plus how far the context has moved on since, or exactly that time while it is not playing.
  - **No drift.** The media time is the first frame's timestamp plus the frames played divided by the rate: an exact count, not a sum of durations, and not the context's own time.
  - **An underrun stops the clock** at the last frame played, and it resumes from there with the audio. A reader that extrapolated past that frame sees the clock step back, by less than a quantum.
  - **Context time is render time.** The worklet knows when the context renders a frame, not when it is heard; whoever schedules video against it must add the output latency (`getOutputTimestamp`).
  - **No torn reads.** The three numbers are written between two increments of a sequence word, and a reader that sees it odd or changed reads again (a seqlock), so any thread reads a consistent clock without a lock or a message.
- **Rate and channels are the context's.** The worklet plays the ring as it is; resampling and mixing happen once, in the media worker, where blocking is allowed and FFmpeg already is.
- **One thread fills both rings,** in file order, and blocks on whichever is full. A consumer of one ring must therefore not wait for the other to fill first: the packet ring and the PCM ring each need room for what the file interleaves between them.
- **Only the core module's codecs play for now.** A stream that needs `audio-ext` is rejected before demuxing starts.

Decoding and resampling are far from the bottleneck: ten minutes of AAC takes about 0.2 s, or 0.5 s resampled from 48 to 44.1 kHz, in every browser (`bench/run.ts`, the `audio` benchmark).

The tests play every fixture through the worklet into an `OfflineAudioContext`, in every browser. They check that what plays equals native `ffmpeg -ar -ac` within 10⁻⁶; that while it plays, the clock is at the media time of what plays, without a gap; that it stops after the last frame, which is native FFmpeg's last; and that over ten minutes every click still starts on its whole second, so the clock has not drifted. Underruns, and a producer thread that waits for room, are tested in Bun against the ring itself.

## Bundling

`dist/` keeps `@snowy-media/ffmpeg` as an import, so the app's bundler resolves it and the WebAssembly files it loads by URL, and an app can update it on its own. The tests have no bundler: `scripts/build.ts` builds them into `test/dist/` with the imports pointing at `/ffmpeg/`, where the test server serves the ffmpeg package.

## Testing

The tests run the engine in Chromium, Firefox and WebKit through Playwright, with a GPU, because WebGPU on a software renderer would leave the code real users run untested. That decides where they run:

| Runner | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| macOS 26 (CI) | yes, with `--enable-gpu` | yes, with a window | yes |
| macOS 15 | yes | yes, with a window | no WebGPU |
| Linux | software renderer only | no WebGPU | no WebGPU |

So CI runs the engine tests on `macos-26`. The checks that a browser can be made to fail have a test where they do: a page without cross-origin isolation in every browser, and WebGPU switched off in Chromium and Firefox (WebKit has no switch).

## Fixtures

`scripts/gen-fixtures.ts` makes the test videos with native FFmpeg 9.0.2, the version `@snowy-media/ffmpeg` builds, and takes every expectation (format, codecs, sizes, timestamps, keyframes, duration) from native `ffprobe`. It covers H.264, HEVC, VP9 and AV1 in MP4, Matroska and WebM, with AAC or Opus, plus a variable frame rate file and a ten-minute file for drift.

Each frame shows its own number in binary, as a row of 16-pixel squares in the top-left corner ([`test/support/frame-id.ts`](../test/support/frame-id.ts)), and the audio clicks at every whole second. A test reads which frame is on screen from the canvas alone, after any decoder and colour conversion, and the clicks mark known instants in the audio. Squares this size survive every lossy codec in the set. The generator decodes every fixture natively and stops if a single frame number or click is more than a millisecond off, so a broken fixture never reaches a test. The output is reproducible (`-fflags +bitexact`, a fixed keyframe interval).
