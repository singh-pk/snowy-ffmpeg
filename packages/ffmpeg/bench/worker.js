// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Bench worker, one fresh worker per run. Message: { lib, opts, files, seeks }. For each
// file: open, seek to each target (the first is cold), close; then open, demux all, close.
//
// Adapter contract (bench/adapters/*.js): create(opts) -> an adapter with open(file),
// demux() -> { packets, bytes }, seek(seconds) -> landed keyframe pts in seconds, close(),
// io() -> { reads, bytes, ms } or null, heapBytes() -> number or null.

const median = (xs) => xs.toSorted((a, b) => a - b)[xs.length >> 1];
const GOP_SECONDS = 2;

async function measure(a, file, seeks) {
  let t = performance.now();
  await a.open(file);
  const openMs = performance.now() - t;
  const seekMs = [];
  let seekErr = 0;

  for (const target of seeks) {
    t = performance.now();
    const landed = await a.seek(target);
    seekMs.push(performance.now() - t);
    // A correct seek lands on the keyframe at or before the target, within one GOP.
    const off = target - landed;
    if (off < 0 || off > GOP_SECONDS + 0.1) seekErr = Math.max(seekErr, Math.abs(off));
  }

  await a.close();

  const ioBefore = a.io() && { ...a.io() };
  await a.open(file);
  t = performance.now();
  const { packets, bytes } = await a.demux();
  const demuxMs = performance.now() - t;
  await a.close();
  const io = a.io();
  const heap = a.heapBytes();

  return {
    openMs,
    seekColdMs: seekMs[0],
    seekWarmMs: median(seekMs.slice(1)),
    seekErr,
    demuxMs,
    packets,
    MBps: bytes / 2 ** 20 / (demuxMs / 1000),
    packetsPerSec: packets / (demuxMs / 1000),
    // Bytes read per byte of file (open + demux); 1 means every byte was read once.
    readAmp: io ? (io.bytes - ioBefore.bytes) / file.size : null,
    // Time inside the read hook (open + demux): FileReaderSync plus the copy into the heap.
    ioMs: io ? io.ms - ioBefore.ms : null,
    heapMB: heap && heap / 2 ** 20,
  };
}

async function run({ lib, opts, files, seeks }) {
  try {
    const { create } = await import(`/bench/adapters/${lib}.js`);
    const t = performance.now();
    const a = await create(opts);
    const instantiateMs = performance.now() - t;
    const results = {};

    for (const file of files) {
      try {
        results[file.name] = await measure(a, file, seeks);
      } catch (e) {
        results[file.name] = { error: String(e) };
      }
    }

    self.postMessage({ instantiateMs, results });
  } catch (e) {
    self.postMessage({ error: String(e?.stack ?? e) });
  }
}

self.addEventListener("message", ({ data }) => void run(data));
