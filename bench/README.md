# Benchmarks

Demux benchmark for the `core` module against [libav.js](https://github.com/Yahweasel/libav.js) 6.10.9 (`webcodecs` variant) and [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.6, in real browsers, reading disk-backed `File`s from `<input type=file>`.

```sh
bun scripts/gen-bench-media.ts       # bench/media: 5 min 1080p30 H.264 20 Mb/s + AAC, ~750 MB per container
bun bench/run.ts --out bench/results/baseline.json
bun bench/variants.ts [name ...]     # build-flag variants (Dockerfile OPT / EXTRA_LDFLAGS) → bench/results/variants
```

Each run is a fresh worker; numbers are the median of 3 runs. Per file: `open` (open + stream info), 10 seeks to fixed timestamps (the first is cold; `seekErr` checks the landed keyframe is in the right GOP), and a full demux with every packet copied out of the WASM heap. Measured on an Apple M-series laptop, so treat small differences as noise; shared CI runners are too noisy to gate on.

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
| snowy `core` (every demuxer, audio + subtitle decoder) | 5,688 KB | 2,576 KB | 2,111 KB |
| libav.js `webcodecs` (5 demuxers) | 2,583 KB | 946 KB | 748 KB |
| mediabunny (≈10 formats, no decoders) | 678 KB | 174 KB | 142 KB |

## Findings

- **I/O dominates.** `FileReaderSync` + the heap copy is ~255 ms of every 750 MB pass, and each call costs ~0.1 ms. At a 64 KiB AVIO buffer, MKV/TS demux took 4× longer. A 4 MiB AVIO buffer is the default; a JS read-ahead block over a small buffer was tried and was slower (more JS↔WASM crossings).
- **Build flags** (Chromium/Firefox/WebKit, [variants](results/variants)): `-O3 -flto` beats no-LTO by 5–14%, `-O2` by 15–30%, `-Os` by 30–100%, with no brotli win. `GROWABLE_ARRAYBUFFERS=2` is up to 45% slower in Chromium. mimalloc, emmalloc, closure and a 16 MB initial heap are noise or worse. The release flags are unchanged.
- **Size** (no-LTO link map): long-tail audio decoders are 30% of `core`, the TX/FFT templates 1.2 MB, and parser/BSF-pulled video code (CBS, VC-1/H.264 DSP) 0.6 MB.
- **Reproducible:** two from-scratch builds produce identical bytes; CI checks [dist.sha256](../dist.sha256).
- **Gap:** FFmpeg's Matroska demuxer is ~200 ms slower than mediabunny's in Chromium only.
