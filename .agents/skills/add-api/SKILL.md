---
name: add-api
description: Expose a new FFmpeg field, function or constant to JavaScript through the API files in src/. Use when JavaScript needs data or behaviour from FFmpeg that the module does not export yet.
---

# Add to the JavaScript API

The whole API of a module is its files in `src/`, listed in `src/sny.h`: `common.c` (every module), `demux.c` (core) and `decode.c` (every module that decodes). JavaScript must never read FFmpeg structs by offset, so every value goes through a function there.

1. **Find the source of truth.** Locate the field or function in FFmpeg's public headers (`libavformat/avformat.h`, `libavcodec/codec_par.h`, `libavcodec/packet.h`, `libavutil/frame.h`, …) inside the build image, for example `docker run --rm <ffmpeg-core stage> grep -n field /opt/sysroot/include/libavformat/avformat.h`. Use only public API, never `internal.h`.
2. **Add the smallest wrapper** in the matching section of the file whose modules need it:
   - a field: `API int sny_codec_width(const AVStream *st) { return st->codecpar->width; }`
   - a call: a short function that returns `0` or a negative AVERROR, with a one-line comment for units or ownership
   - a constant: `SNY_CONST(NAME, value)`, or `SNY_CONST64` for 64-bit values; the compiler checks the value
   - Name it `sny_<object>_<field>`. Use `int64_t` for timestamps and sizes (they become `bigint`), pointers for objects, `int` otherwise.
3. **Regenerate and build:** `bun run build` (only relinks when the FFmpeg layers are cached; a fresh clone rebuilds FFmpeg first). Check the new signature in `dist/<module>/index.d.ts`.
4. **Test it** in `test/demux.worker.js` against a value native `ffprobe` reports, adding the field to `scripts/gen-fixtures.ts` if the expectation is new, then `bun run fixtures` and `bun test`.
5. **Record** the build output change: `shasum -a 256 dist/core/core.{js,wasm} dist/audio-ext/audio-ext.{js,wasm} > dist.sha256`, and add a line to `CHANGELOG.md` under *Unreleased*.

Keep getters one line. If logic is needed, it belongs in C, not in JavaScript reading memory.
