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
- **The ring being full is the backpressure.** The producer blocks in `Atomics.wait` until the consumer frees room. The consumer never blocks: it waits for a message the producer posts on a `MessageChannel` between them. Each side raises a waiting flag before it checks the other's position, and the other wakes it only when that flag is up, so a wake-up is never lost and a busy ring makes no `notify` calls and posts no messages. The producer takes the consumer's flag as it posts, so each wait gets one message.
- **Watching the producer block.** A consumer can also watch for the producer's thread to block, on this ring or on another one the thread writes, such as the PCM ring. It raises a watch flag before it reads whether the producer waits, and the producer, about to block, takes the flag and posts one message, the same way.
- **A message, not `Atomics.waitAsync`.** WebKit now and then drops an `Atomics.waitAsync` waiter: roughly once in ten thousand waits, after the page has run other workers, the wait never settles and no later `notify` reaches it (a run of the ring benchmark's 500 packets, one every 2 ms, hung in one page in 17). A message is an event every browser delivers; it wakes a little later, in Firefox and WebKit by about 0.2 ms at the 99th percentile, which only matters while the ring is empty and video already waits for the demuxer.
- **Ending and closing.** A record with stream `END` follows the last packet, and one with stream `FAILED` ends the packets when the producer fails, so the consumer never waits for packets that will not come; the error itself goes to whoever started the producer. The consumer closes the ring to stop the producer, whose next write returns false; a closed ring holds no packets.
- **Capacity: 8 MiB.** That holds seconds of the highest bitrates a browser plays (4K HEVC at 100 Mbit/s is 12.5 MB a second) and any single packet. Moving packets through the ring takes far less time than decoding them: under 0.5 µs per packet, and over 20 GB/s for large packets. A wake-up takes under 0.1 ms at the 99th percentile in Chromium and under 0.4 ms in Firefox and WebKit (`bench/run.ts`, the `ring` benchmark).

The tests check the ring between two threads in Bun, and check, in every browser, that the packets of every fixture pass through a 64 KiB ring exactly as native `ffprobe` lists them.

## Audio and clock

The media worker decodes the audio itself, with FFmpeg, as it demuxes, and `sny_resample` converts each frame in one call to what the `AudioContext` plays: its sample rate, stereo or the destination's channels, 32-bit float. The samples go into a second ring (`src/pcm.ts`), and the engine's AudioWorklet (`src/audio.worklet.ts`) plays them from there.

- **The PCM ring** is a `SharedArrayBuffer` of interleaved frames with the same growing positions as the packet ring, and its channel count and rate in its header. The producer blocks while it is full. The AudioWorklet may never block, so it never waits: when the ring runs out, it plays silence for the rest of the render quantum. That is an underrun.
- **The AudioWorklet owns the clock.** After each quantum it publishes the media time of the next frame it will play and the context time that frame plays at, and whether it is playing. A reader's media time is that time plus how far the context has moved on since, or exactly that time while it is not playing.
  - **No drift.** The media time is the first frame's timestamp plus the frames played divided by the rate: an exact count, not a sum of durations, and not the context's own time.
  - **An underrun stops the clock** at the last frame played, from the context time that frame plays at; until then the clock runs, since the audio before the underrun is still being heard, so at the end of a file the clock neither jumps by the output latency nor steps back. It resumes from there with the audio. An underrun shorter than the output latency makes `currentTime` step back by up to the gap, since what is heard just after the resume was rendered before it; frames never go back.
  - **Context time is render time.** The worklet knows when the context renders a frame, not when it is heard; whoever schedules video against it must add the output latency (`getOutputTimestamp`).
  - **No torn reads.** The three numbers are written between two increments of a sequence word, and a reader that sees it odd or changed reads again (a seqlock), so any thread reads a consistent clock without a lock or a message.
- **Rate and channels are the context's.** The worklet plays the ring as it is; resampling and mixing happen once, in the media worker, where blocking is allowed and FFmpeg already is.
- **One thread fills both rings,** in file order, and blocks on whichever is full. A consumer of one ring must therefore not wait for the other to fill first: the packet ring and the PCM ring each need room for what the file interleaves between them.
- **Only the core module's codecs play for now.** A stream that needs `audio-ext` is rejected before demuxing starts.

Decoding and resampling are far from the bottleneck: ten minutes of AAC takes about 0.2 s, or 0.5 s resampled from 48 to 44.1 kHz, in every browser (`bench/run.ts`, the `audio` benchmark).

The tests play every fixture through the worklet into an `OfflineAudioContext`, in every browser. They check that what plays equals native `ffmpeg -ar -ac` within 10⁻⁶; that while it plays, the clock is at the media time of what plays, without a gap; that it stops after the last frame, which is native FFmpeg's last; and that over ten minutes every click still starts on its whole second, so the clock has not drifted. Underruns, and a producer thread that waits for room, are tested in Bun against the ring itself.

## Video decoder configs

WebCodecs decodes H.264, HEVC, VP8, VP9 and AV1, given a `VideoDecoderConfig` (`src/codec.ts`). The media worker sends each video stream's parameters when it opens a file (FFmpeg's codec name, the container's four-character code, the extradata, the size, any level the container states, the sample aspect ratio, the time base and the display matrix), and the config is made from them and the stream's first packet, a keyframe.

- **The codec string is built as its spec defines it,** from the configuration record (avcC, hvcC, av1C), which also becomes the config's `description`. Where the container has no record (MPEG-TS, raw streams), it comes from the parameter sets in band (the SPS, or AV1's sequence header OBU), in the extradata or in the keyframe, and there is no description: packets then carry their parameter sets themselves.
- **VP9 has no record in WebM,** so its profile and bit depth come from the keyframe's uncompressed header. Its level is the container's, or else the smallest whose picture size fits the stream (VP9 Annex A): browsers decode by the bitstream and the level is only a hint.
- **Non-square pixels set the display aspect** (`displayAspectWidth` and `displayAspectHeight`), so a frame's display size is the size it is shown at before rotation.
- **The config leaves out rotation and flip.** They are the display matrix's, applied where frames are drawn, the same for every decoder.
- **Firefox's WebCodecs has no HEVC.** `isConfigSupported` says so, and the tests record it.
- **WebKit decodes AV1 only in hardware,** on an Apple M3 or later, yet says it supports AV1 on any Mac. Elsewhere the decoder fails on the first frame (`EncodingError`), as it does on CI's runners, and the tests accept that failure, and only that one.

The tests check every fixture in every browser. The decoder takes the config and decodes the first packet to frame 0. The codec string equals the one native FFmpeg writes, where it writes one (H.264 and AV1). The same holds for each stream converted to how a container without a record carries it: Annex B, its parameter sets in band. Bun unit tests cover the spec's HEVC example, VP9 profile 2, and AV1 sequence headers with timing and decoder model information, a high tier, and 10- and 12-bit depths.

## Video output

The render worker decodes a video stream's packets from the packet ring with a `VideoDecoder` and shows them through the compositor (`src/video.ts`). The packet's data goes straight from the ring into an `EncodedVideoChunk`, which copies it, so the ring frees it at once.

- **The frame queue** (`src/frames.ts`) keeps decoded frames in presentation order, whatever order they arrive in, and is bounded by the bytes they hold, 64 MiB: two or three 4K 10-bit frames, hundreds of small ones. A frame on the GPU, without a pixel format, counts as RGBA.
- **Closing** stops decoding at once, wherever it waits, and closes every frame; it is not a failure.
- **Decoding waits** while the queue is full or the decoder holds 8 packets it has not decoded, and goes on when a frame is shown or the decoder takes a packet (its `dequeue` event). Neither memory nor the decoder's backlog grows. A hardware decoder's pool of frames may run out before the byte budget does; in playback the frames come back as they are shown, so decoding goes on. A seek must drop the frames before its target as they arrive, or the pool would stall it.
- **Presenting** shows the latest frame due at the media time and closes the ones before it, which were never shown in time; the frame on screen is closed when the next one replaces it. Timestamps are the packets' pts in microseconds, rounded, or their dts where they have no pts, which is right for a stream without B-frames; a packet with neither is an error.
- **The compositor** (`src/compositor.ts`) samples each frame as an external texture, which converts it to RGB with its own colour space (SDR for now), and draws one triangle over the canvas. Its uniform maps the canvas to the frame's texture through the inverse of FFmpeg's display matrix, so rotation and flip cost nothing, fitted and centred with black around it. An external texture lasts one task, so each frame gets its own bind group; with the `EncodedVideoChunk` that each packet needs, that is all a frame allocates.

The tests (`test/render.test.ts`) decode every fixture from the ring into a canvas they read back, in every browser. Each frame goes up at its own timestamp with its own number, stays up halfway to the next, and a jump shows the frame due and skips the rest. The first frame, drawn at the size it is shown at, has the layout of native FFmpeg's, rotated and mirrored fixtures included: their brightness grids correlate above 0.9, where a mirrored one comes to about 0.76 and one turned the wrong way below 0. The levels are not compared, because for an untagged stream each browser and FFmpeg assume their own YUV matrix, and Chromium converts the transfer too; matching colour is the colour pipeline's.

## Playback

`engine.play()` plays the open file's first video and first audio track through all three threads, and `pause()` holds it.

- **The main thread** makes one `AudioContext` on the first play and keeps it, starts the worklet on a PCM ring of a power of two frames, a second and more at the context's rate, in stereo, asks the render worker to play the video from a packet ring, and asks the media worker to demux into both. The media worker fills both rings in file order, so the PCM ring is what lets it demux video a second ahead of the audio.
- **What is heard now** is the one thing every thread needs and only the main thread can read: `AudioContext.getOutputTimestamp()` says which context time is being heard at which moment. The main thread publishes it into the PCM ring's header on every animation frame, with whether the context runs, under a seqlock. Until output starts the timestamp is zero, which is published as not running, so nothing is shown ahead of what is heard. Any thread then gets the media time heard at any moment, on the clock of `performance.timeOrigin + performance.now()` that all threads share: the context time heard then, carried forward from the timestamp while the context runs, through the worklet's clock. The output latency is in it, as the browser reports it.
- **Starting** suspends the context, which a user gesture or the last file may have left running, and waits, before it resumes, for the render worker to decode a quarter of a second of video (or, once the media worker is blocked, as much as the frame queue holds) and for a quarter of a second of audio in the PCM ring (or the whole file, if shorter), so a slow start delays both together instead of letting audio run ahead or underrun. While the context waits, nothing drains the PCM ring, so the wait also ends when the render worker says video is stuck: the media worker is blocked, on a full PCM ring or a full packet ring, and video gets no further, as it waits for packets with nothing to decode (sparse video) or its frame queue is full (a short audio track). Every step is an event, with no timer and no polling. The media worker says once that the audio is buffered: a quarter of a second written, a full PCM ring, or all of it. The render worker works out how far it has decoded on each event that may change it: a frame decoded, the decoder taking a packet, a wait for packets begun, the end decoded, and the media worker blocking, which it watches for through the packet ring. It reports each change until it has drawn a frame by the running clock. A hidden page waits to be shown before it starts audio, as its animation frames, and so video, wait too. A decoder slow to start delays play until it decodes. One that stops taking packets with frames out, as a hardware decoder whose pool has run out would, gives no event, and would hold play; no test has shown it. A pause ends it as well; `play` resolves once audio is heard, by an output timestamp that has settled, and the render worker has drawn a frame by it. The first timestamps after output starts are estimates, which Chromium corrects by up to 35 ms and Firefox by 10 ms, so the clock runs only once two in a row agree with the one before within 2 ms, or after ten, for timers too coarse to agree; after that it keeps running until the context stops, as Firefox's then wanders by a few milliseconds.
- **The render worker** shows, on each of its own animation frames, the frame due when that animation frame reaches the screen: its start plus the refresh interval, the shortest of its last eight gaps, so one late animation frame does not move the next one's target. `engine.currentTime` is the same media time, read on the main thread.
- **Pausing** suspends the context: the worklet stops, the timestamp stops running, and the clock and the frame stop with it. The stopped timestamp is published as the context suspends, not on the next animation frame, so `currentTime` holds once `pause` resolves, in a hidden page too. The frame on screen stays, and may be up to two frames ahead of the clock: it went up for a refresh later, and Firefox's output timestamp falls back by its output latency as it suspends. Frames never go back until seeking does.
- **Opening a file, or a failure,** stops what plays: both rings are closed, which frees the media worker, the worklet ends, and the render worker closes its frames. A `play` still starting when an open comes rejects with an `AbortError` and sends nothing, as the media worker may already hold the new file; a `pause` that comes while `play` starts wins. Each play has an id, so a failure reported late for one that has stopped is ignored. A failure in either worker makes the next `play` or `pause` reject with it, until the next open, and `currentTime` reads 0 meanwhile; nothing else signals it yet.
- **A hidden page** has no animation frames, so a `play` there resolves, and video runs, once it is shown.
- **Not yet:** a file without audio (it needs a clock without audio), a choice of track, seeking, and audio far into the file: if more video comes before the first audio than the frame queue and the packet ring hold, play starts with the media worker blocked short of the audio, and the clock never moves. A video stream WebCodecs cannot decode fails when it starts.

The tests (`test/play.test.ts`) play `sync-10min.mp4` in real time in every browser, through the public API alone, reading the frame number off the canvas on every animation frame of the page: the frame on screen is the one due at `engine.currentTime` within 20 ms, from the first animation frame, and a pause holds both. Firefox reads its canvas back up to four frames stale, which looks like a late frame, so there no frame may be early by 20 ms, 99 % must be within 20 ms, and none may look later than 150 ms. On CI the virtual machines' GPUs do not draw in real time: Chromium's page gets 30 animation frames a second, and video falls behind by up to three quarters of a second (p99 82 ms in Chromium, 58 ms in WebKit); when the machine stalls, Firefox's output timestamp jumps as it catches up, and a frame looks early by up to 86 ms; and Firefox's audio output stalls, so its clock ends up to 1.2 s short over 20 s. There the test checks that the clock runs in real time (losing at most a second, two in Firefox) and that a pause holds, bounds lateness by a second, earliness and the 99th percentile by 0.15 s, and logs its percentiles; the 20 ms bound holds on real hardware, and in the ten-minute run. CI plays 20 seconds; `SNOWY_SYNC_SECONDS=600` plays all ten minutes. Firefox now and then reads back the canvas as it was a few frames before; the queue never goes back, so in Firefox a frame older than one already read is left out, and in every browser the first read is, which now and then shows a frame from five or more frames before (in Chromium too, with the due frame on the next read under a millisecond later): about 1 % of reads, 4 % under load, 6 % on CI, and the test allows a tenth. The newest frame read is always checked, so this hides no frame shown ahead.

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

`scripts/gen-fixtures.ts` makes the test videos with native FFmpeg 9.0.2, the version `@snowy-media/ffmpeg` builds, and takes every expectation (format, codecs, sizes, timestamps, keyframes, duration) from native `ffprobe`. It covers H.264, HEVC, VP9 and AV1 in MP4, Matroska and WebM, with AAC or Opus, plus a variable frame rate file, a ten-minute file for drift, and files whose display matrix turns them a quarter turn, and also mirrors them. For each, it records the first frame as FFmpeg shows it, as a grid of mean brightness.

Each frame shows its own number in binary, as a row of 16-pixel squares in the top-left corner ([`test/support/frame-id.ts`](../test/support/frame-id.ts)), and the audio clicks at every whole second. A test reads which frame is on screen from the canvas alone, after any decoder and colour conversion, and the clicks mark known instants in the audio. Squares this size survive every lossy codec in the set. The generator decodes every fixture natively and stops if a single frame number or click is more than a millisecond off, so a broken fixture never reaches a test. The output is reproducible (`-fflags +bitexact`, a fixed keyframe interval).
