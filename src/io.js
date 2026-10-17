// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Emscripten JS library: FFmpeg's AVIO callbacks are direct WASM imports that call
// hooks the worker installs on the module (`snyRead`, `snySeek`). No addFunction,
// no table growth, no indirect calls.

addToLibrary({
  // (io, buf, size) -> bytes read; 0 = end of file; < 0 = AVERROR
  sny_io_read__sig: "iipi",
  sny_io_read: (io, buf, size) => Module["snyRead"](io, buf, size),

  // (io, offset: bigint, whence) -> new position, or the size for AVSEEK_SIZE; < 0 = AVERROR
  sny_io_seek__sig: "jiji",
  sny_io_seek: (io, offset, whence) => Module["snySeek"](io, offset, whence),
});
