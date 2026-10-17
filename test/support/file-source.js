// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Serves a module's AVIO reads from one File with FileReaderSync (worker only). Shared by
// the tests and the benchmarks.

import { AVSEEK_SIZE } from "/dist/core/index.js";

const EINVAL = -28;

/**
 * Installs the `snyRead`/`snySeek` hooks on `core`. Call `open(file)` before each
 * `sny_open`; `stats` counts the read calls, bytes and milliseconds spent reading since the
 * hooks were installed.
 */
export function attachFileSource(core) {
  const reader = new FileReaderSync();
  const stats = { reads: 0, bytes: 0, ms: 0 };
  let file = null;
  let pos = 0;

  core.snyRead = (_io, buf, size) => {
    const start = performance.now();
    const end = Math.min(file.size, pos + size);
    if (end <= pos) return 0;
    const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, end)));
    core.HEAPU8.set(bytes, buf);
    pos = end;
    stats.reads++;
    stats.bytes += bytes.length;
    stats.ms += performance.now() - start;
    return bytes.length;
  };

  core.snySeek = (_io, offset, whence) => {
    if (whence === AVSEEK_SIZE) return BigInt(file.size);
    const next = [0, pos, file.size][whence] + Number(offset);
    if (next < 0 || next > file.size) return BigInt(EINVAL);
    pos = next;
    return BigInt(pos);
  };

  return {
    stats,
    open(f) {
      file = f;
      pos = 0;
    },
  };
}
