// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The media worker's demux pump in Chromium: through a ring much smaller
// than each file, every stream's packets (timestamps, key flag, size and bytes) equal native
// ffprobe's (test/fixtures/expected.json); and a pump that fails ends the ring with FAILED.
// Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { launch } from "./support/browsers";
import { MEDIA_WORKER, PAGE, serveEngine } from "./support/serve";

interface Hash {
  id: number;
  packets: number;
  packetsSha256: string;
}

const expected: Record<string, { packetDts: boolean; video: Hash; audio: Hash }> = await Bun.file(
  new URL("fixtures/expected.json", import.meta.url),
).json();
const fixtures = Object.entries(expected).map(([name, e]) => ({
  name,
  dts: e.packetDts,
  streams: [e.video.id, e.audio.id],
}));
const server = await serveEngine("<!doctype html><title>test</title>");

afterAll(() => server.stop(true));

test("demuxes every fixture as ffprobe does", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    const hashes = await tab.evaluate(
      async ({ page, worker, files }) => {
        const support: typeof import("./support/page") = await import(page);
        const media = support.startMedia(worker);
        const all: Record<string, Awaited<ReturnType<typeof support.hashRing>>> = {};

        for (const { name: n, dts, streams } of files) {
          const res = await fetch(`/test/fixtures/${n}`);
          const blob = await res.blob();
          await media.request({ type: "open", file: new File([blob], n) });
          // 256 KiB: room for an uncompressed frame, and smaller than the larger fixtures, so
          // records wrap and the pump waits.
          const ring = support.createRing(1 << 18);
          const hashed = support.hashRing(ring, dts);
          await media.request({ type: "demux", ring, streams, from: 0 });
          all[n] = await hashed;
        }

        media.stop();
        return all;
      },
      { page: PAGE, worker: MEDIA_WORKER, files: fixtures },
    );

    for (const [file, { video, audio }] of Object.entries(expected)) {
      const got = hashes[file];
      if (typeof got !== "object") throw new Error(`${file}: ${String(got)}`);
      const want = (h: Hash) => ({ packets: h.packets, packetsSha256: h.packetsSha256 });
      expect(got[video.id], `${file} video`).toEqual(want(video));
      expect(got[audio.id], `${file} audio`).toEqual(want(audio));
    }
  } finally {
    await browser.close();
  }
}, 120_000);

// The pump fails on a packet larger than the ring, and on a stream the file lacks.
test("a pump that fails ends the ring with FAILED", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    const results = await tab.evaluate(
      async ({ page, worker }) => {
        const support: typeof import("./support/page") = await import(page);
        const media = support.startMedia(worker);
        const res = await fetch("/test/fixtures/h264-aac.mp4");
        const blob = await res.blob();
        await media.request({ type: "open", file: new File([blob], "h264-aac.mp4") });

        async function demux(capacity: number, streams: number[]) {
          const ring = support.createRing(capacity);
          const hashed = support.hashRing(ring, false);

          try {
            await media.request({ type: "demux", ring, streams, from: 0 });
            const ended = await hashed;
            return ["replied", ended];
          } catch (e) {
            const ended = await hashed;
            return [String(e), ended];
          }
        }

        const tooSmall = await demux(64, [0]);
        const noStream = await demux(1 << 16, [7]);
        media.stop();
        return { tooSmall, noStream };
      },
      { page: PAGE, worker: MEDIA_WORKER },
    );

    expect(results.tooSmall).toEqual([expect.stringContaining("exceeds the ring"), "failed"]);
    expect(results.noStream).toEqual(["Error: demux: no stream 7", "failed"]);
  } finally {
    await browser.close();
  }
}, 60_000);
