# Benchmarks

Demux, audio decode and video decode benchmarks. The demux benchmark compares against [libav.js](https://github.com/Yahweasel/libav.js) 6.10.9 (`webcodecs` variant) and [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.6, in real browsers, reading disk-backed `File`s from `<input type=file>`.

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
| **snowy** Firefox 157 | **498** | **490** | **486** | **1,042** |
| mediabunny Firefox | 877 | 870 | 979 | 23,083 |
| libav.js Firefox | 2,186 | 2,156 | 2,214 | unsupported |
| **snowy** WebKit 27.2 | **287** | **274** | **254** | **682** |
| mediabunny WebKit | 40,079 | 40,553 | 1,538 | 63,059 |
| libav.js WebKit | 11,298 | 21,110 | 27,936 | unsupported |

Open is 4–18 ms and warm keyframe seeks 1.5–3 ms for snowy in every browser and container (the 16–18 ms MP4 open is the `moov` at the end of the file). Instantiate: 10–15 ms (Chromium, WebKit), 40–50 ms (Firefox).

Shipped size:

| | raw | gzip | brotli |
|---|---|---|---|
| snowy `core` (every demuxer, common audio decoders, subtitle decoders) | 4,243 KB | 1,703 KB | 1,352 KB |
| snowy `audio-ext` (long-tail audio decoders, loaded on demand) | 2,215 KB | 1,186 KB | 1,006 KB |
| snowy `video` (common video decoders, dav1d, libswscale, loaded on demand) | 6,845 KB | 1,683 KB | 1,197 KB |
| snowy `video-ext` (every other video decoder, loaded on demand) | 8,179 KB | 2,323 KB | 1,692 KB |
| libav.js `webcodecs` (5 demuxers) | 2,583 KB | 946 KB | 748 KB |
| mediabunny (≈10 formats, no decoders) | 678 KB | 174 KB | 142 KB |

## Audio decode

One minute of 48 kHz pink noise per codec (a different seed per channel, harder than music for every decoder), demuxed from Matroska and decoded to float planar with every frame copied out of the WASM heap. Median of 3 runs, 2026-10-17, [audio.json](results/audio.json), same machine. Milliseconds, and multiple of real time:

| Codec | Chromium 156 | Firefox 157 | WebKit 27.2 |
|---|---|---|---|
| E-AC-3 5.1, 640 kb/s | 73 ms, 818× | 85 ms, 710× | 74 ms, 812× |
| TrueHD 5.1, 24-bit | 321 ms, 187× | 371 ms, 162× | 357 ms, 168× |
| AC-3 5.1, 640 kb/s | 78 ms, 766× | 91 ms, 656× | 81 ms, 740× |
| DTS 5.1 | 171 ms, 350× | 192 ms, 312× | 184 ms, 327× |
| AAC stereo, 256 kb/s | 44 ms, 1,349× | 44 ms, 1,376× | 43 ms, 1,380× |
| Opus stereo, 160 kb/s | 88 ms, 684× | 100 ms, 602× | 90 ms, 667× |
| MP3 stereo, 320 kb/s | 54 ms, 1,117× | 63 ms, 948× | 59 ms, 1,024× |
| FLAC stereo, 24-bit | 78 ms, 773× | 83 ms, 720× | 87 ms, 691× |

## Video decode

10 seconds of 1080p30 per codec, a moving test pattern with film grain at 8 Mb/s (the grain leaves residuals in every block, so decoders work as hard as on camera footage), demuxed from Matroska by `core` and decoded by `video`, each frame packed and copied out of the WASM heap as a `VideoFrame` needs. Timing starts once the decoder is open. Median of 3 runs, 2026-10-18, [video.json](results/video.json), same machine (10 cores). Frames per second, by decoding threads:

| Codec | Chromium 156 (1 / 2 / 4 / 8) | Firefox 157 | WebKit 27.2 |
|---|---|---|---|
| H.264 (x264 medium) | 189 / 301 / 407 / 536 | 171 / 254 / 334 / 427 | 191 / 271 / 368 / 509 |
| HEVC (x265 fast) | 113 / 171 / 189 / 228 | 86 / 128 / 142 / 177 | 95 / 145 / 169 / 210 |
| VP9 | 135 / 193 / 210 / 207 | 123 / 165 / 179 / 174 | 125 / 158 / 187 / 190 |
| AV1 (dav1d) | 99 / 151 / 180 / 201 | 78 / 112 / 137 / 154 | 73 / 129 / 159 / 186 |

One thread decodes every codec at 2.4× real time or more in every browser. VP9 gains nothing past 4 threads.

FFmpeg's WebAssembly SIMD code is HEVC's inverse transforms and SAO filters. Built with `--disable-simd128` ([no-simd128.json](results/variants/no-simd128.json), `bun bench/variants.ts no-simd128`), HEVC decodes at about half the speed in every browser and at every thread count, while H.264, the control, stays within run-to-run noise:

| HEVC fps, 1 / 8 threads | Chromium 156 | Firefox 157 | WebKit 27.2 |
|---|---|---|---|
| simd128 (release) | 113 / 228 | 86 / 177 | 95 / 210 |
| `--disable-simd128` | 55 / 122 | 45 / 99 | 48 / 114 |

## Findings

- **I/O dominates.** `FileReaderSync` + the heap copy is ~255 ms of every 750 MB pass, and each call costs ~0.1 ms. At a 64 KiB AVIO buffer, MKV/TS demux took 4× longer. A 4 MiB AVIO buffer is the default; a JS read-ahead block over a small buffer was tried and was slower (more JS↔WASM crossings).
- **Build flags** (Chromium/Firefox/WebKit, [variants](results/variants)): `-O3 -flto` beats no-LTO by 5–14%, `-O2` by 15–30%, `-Os` by 30–100%, with no brotli win. `GROWABLE_ARRAYBUFFERS=2` is up to 45% slower in Chromium. mimalloc, emmalloc, closure and a 16 MB initial heap are noise or worse. The release flags are unchanged.
- **Size** (no-LTO link map): long-tail audio decoders were 30% of `core`; moving them to `audio-ext` took `core` from 2,161 KB to 1,325 KB brotli, with demux and decode speed unchanged. Of the rest, the TX/FFT templates are 1.2 MB and parser/BSF-pulled video code (CBS, VC-1/H.264 DSP) 0.6 MB.
- **Video:** one decoding thread already plays 1080p30 in every codec and browser with 2.4× headroom; the thread pool matters for 4K, high frame rates and seeking. simd128 doubles HEVC; dav1d has no WebAssembly assembly and relies on the compiler's vectorisation. mimalloc, re-tested with decoders on threads ([video-mimalloc.json](results/variants/video-mimalloc.json)), is up to 15% slower in Chromium and within noise elsewhere, so the default allocator stays.
- **Reproducible:** two from-scratch builds produce identical bytes; CI checks [dist.sha256](../dist.sha256).
- **Gap:** FFmpeg's Matroska demuxer is ~200 ms slower than mediabunny's in Chromium only.
