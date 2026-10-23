# Benchmarks

Demux, audio decode and video decode benchmarks. The demux benchmark compares against [libav.js](https://github.com/Yahweasel/libav.js) 6.10.9 (`webcodecs` variant) and [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.6, in Chromium, reading disk-backed `File`s from `<input type=file>`.

```sh
bun scripts/gen-bench-media.ts       # bench/media: 5 min 1080p30 H.264 20 Mb/s + AAC, ~750 MB per container
bun bench/run.ts --out bench/results/baseline.json
bun bench/variants.ts [name ...]     # build-flag variants (Dockerfile OPT / EXTRA_LDFLAGS) → bench/results/variants
bun bench/decode.ts --out bench/results/audio.json   # audio decode, one minute per codec
bun bench/video.ts --out bench/results/video.json    # video decode, 10 s of 1080p30 per codec
```

Each run is a fresh worker; numbers are the median of 3 runs. Per demux file: `open` (open + stream info), 10 seeks to fixed timestamps (the first is cold; `seekErr` checks the landed keyframe is in the right GOP), and a full demux with every packet copied out of the WASM heap. Measured on an Apple M-series laptop, so treat small differences as noise; shared CI runners are too noisy to gate on.

## Results (2026-10-17, [baseline.json](results/baseline.json))

Full demux of ~750 MB (23,064 packets), ms:

| | MP4 | MP4 faststart | MKV | MPEG-TS |
|---|---|---|---|---|
| **snowy** Chromium 156 | 405 | 381 | 560 | **803** |
| mediabunny Chromium | 396 | 380 | **358** | 1,944 |
| libav.js Chromium | 4,041 | 4,150 | 3,956 | unsupported |

Open is 4–18 ms and warm keyframe seeks 1.5–3 ms for snowy in every container (the 16–18 ms MP4 open is the `moov` at the end of the file). Instantiate takes 10 ms.

Shipped size:

| | raw | gzip | brotli |
|---|---|---|---|
| snowy `core` (every demuxer, common audio decoders, subtitle decoders) | 4,243 KB | 1,703 KB | 1,352 KB |
| snowy `audio-ext` (long-tail audio decoders, loaded on demand) | 2,215 KB | 1,186 KB | 1,006 KB |
| snowy `video` (common video decoders, dav1d, libswscale, loaded on demand) | 6,845 KB | 1,684 KB | 1,197 KB |
| snowy `video-ext` (every other video decoder, loaded on demand) | 8,179 KB | 2,323 KB | 1,692 KB |
| libav.js `webcodecs` (5 demuxers) | 2,583 KB | 946 KB | 748 KB |
| mediabunny (≈10 formats, no decoders) | 678 KB | 174 KB | 142 KB |

## Audio decode

One minute of 48 kHz pink noise per codec (a different seed per channel, harder than music for every decoder), demuxed from Matroska and decoded to float planar with every frame copied out of the WASM heap. Median of 3 runs, 2026-10-17, [audio.json](results/audio.json), same machine. Milliseconds, and multiple of real time:

| Codec | Chromium 156 |
|---|---|
| E-AC-3 5.1, 640 kb/s | 73 ms, 818× |
| TrueHD 5.1, 24-bit | 321 ms, 187× |
| AC-3 5.1, 640 kb/s | 78 ms, 766× |
| DTS 5.1 | 171 ms, 350× |
| AAC stereo, 256 kb/s | 44 ms, 1,349× |
| Opus stereo, 160 kb/s | 88 ms, 684× |
| MP3 stereo, 320 kb/s | 54 ms, 1,117× |
| FLAC stereo, 24-bit | 78 ms, 773× |

## Video decode

10 seconds of 1080p30 per codec, a moving test pattern with film grain at 8 Mb/s (the grain leaves residuals in every block, so decoders work as hard as on camera footage), demuxed from Matroska by `core` and decoded by `video`, each frame packed and copied out of the WASM heap as a `VideoFrame` needs. Timing starts once the decoder is open. Median of 3 runs, 2026-10-18, [video.json](results/video.json), same machine (10 cores). Frames per second, by decoding threads:

| Codec | Chromium 156 (1 / 2 / 4 / 8) |
|---|---|
| H.264 (x264 medium) | 189 / 301 / 407 / 536 |
| HEVC (x265 fast) | 113 / 171 / 189 / 228 |
| VP9 | 135 / 193 / 210 / 207 |
| AV1 (dav1d) | 99 / 151 / 180 / 201 |

One thread decodes every codec at 99 fps or more, over 3× real time. VP9 gains nothing past 4 threads.

FFmpeg's WebAssembly SIMD code is HEVC's inverse transforms and SAO filters. Built with `--disable-simd128` ([no-simd128.json](results/variants/no-simd128.json), `bun bench/variants.ts no-simd128`), HEVC decodes at about half the speed at every thread count, while H.264, the control, stays within run-to-run noise:

| HEVC fps, 1 / 8 threads | Chromium 156 |
|---|---|
| simd128 (release) | 113 / 228 |
| `--disable-simd128` | 55 / 122 |

`VideoFrame` takes 10-bit and 4:2:2 frames in their own formats (`I420P10`, `I422P10`, …), so `sny_to_video_format` passes them through instead of converting them to 8-bit 4:2:0 with libswscale ([before](results/video-formats/before.json) and [after](results/video-formats/after.json), one session; 8-bit media, which converts in neither, ran 1–6 % slower):

| fps, 1 / 8 threads | converted to I420 | as they are |
|---|---|---|
| H.264 10-bit 4:2:0 | 159 / 532 | 183 / 776 |
| ProRes 422 10-bit 4:2:2 | 39 / 125 | 52 / 285 |

## Findings

- **I/O dominates.** `FileReaderSync` + the heap copy is ~255 ms of every 750 MB pass, and each call costs ~0.1 ms. At a 64 KiB AVIO buffer, MKV/TS demux took 4× longer. A 4 MiB AVIO buffer is the default; a JS read-ahead block over a small buffer was tried and was slower (more JS↔WASM crossings).
- **Build flags** ([variants](results/variants)): the release flags were chosen over no-LTO, `-O2`, `-Os`, brotli, `GROWABLE_ARRAYBUFFERS=2`, mimalloc, emmalloc, closure and a 16 MB initial heap. The runs kept here come from more than one session, so they are not compared with each other: a change of flags measures the base and the variant again, in one session.
- **Size** (no-LTO link map): long-tail audio decoders were 30% of `core`; moving them to `audio-ext` took `core` from 2,161 KB to 1,325 KB brotli, with demux and decode speed unchanged. Of the rest, the TX/FFT templates are 1.2 MB and parser/BSF-pulled video code (CBS, VC-1/H.264 DSP) 0.6 MB.
- **Video:** one decoding thread already plays 1080p30 in every codec with over 3× headroom; the thread pool matters for 4K, high frame rates and seeking. simd128 doubles HEVC; dav1d has no WebAssembly assembly and relies on the compiler's vectorisation. mimalloc, re-tested with decoders on threads ([video-mimalloc.json](results/variants/video-mimalloc.json)), is up to 15% slower, so the default allocator stays.
- **Reproducible:** two from-scratch builds produce identical bytes; CI checks [dist.sha256](../dist.sha256).
- **Gap:** FFmpeg's Matroska demuxer is ~200 ms slower than mediabunny's.
