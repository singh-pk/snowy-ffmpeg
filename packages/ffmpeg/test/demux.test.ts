// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Opens every fixture with the WASM core in Chromium, Firefox and WebKit, decodes its audio
// and video, and compares the result with native FFmpeg 9.0.2. Usage: bun test (after building dist/).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import expected from "./fixtures/expected.json";
import { serve } from "../../../tooling/test-server";

const server = serve(new URL("../", import.meta.url), "<!doctype html><title>test</title>");
afterAll(() => server.stop(true));

// Float decoders differ from native FFmpeg in the last bits: native builds fuse multiply-adds
// and WebAssembly cannot. This bounds the difference per sample, in full scale.
const FLOAT_TOLERANCE = 1e-6;

interface Audio {
  frames: number;
  samples: number;
  firstPts: (string | null)[];
  sha256: string;
}

// Audio resampled by sny_resample: samples per channel and every PROBE_STRIDE-th value.
interface Resampled {
  samples: number;
  probe: string | number[];
}

interface Stream {
  [key: string]: unknown;
  audio?: Audio & { exact?: boolean; probe?: string | number[]; resampled?: Resampled };
  video?: { [key: string]: unknown; videoFrame?: string };
}

interface Result {
  [key: string]: unknown;
  streams?: Stream[];
}

const fixtures: Record<string, Result> = expected;
const names = Object.keys(fixtures);

for (const [engine, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
] as [string, BrowserType][]) {
  describe(engine, () => {
    let browser: Browser;
    let isolated = false;
    let results: Record<string, Result> = {};
    let transferred: Record<string, Result> = {};

    beforeAll(async () => {
      browser = await type.launch();
      const page = await browser.newPage();
      page.on("console", (m) => m.type() === "error" && console.error(`[${engine}]`, m.text()));
      page.on("pageerror", (e) => console.error(`[${engine}]`, e.message));
      await page.goto(server.url.href);
      isolated = await page.evaluate(() => crossOriginIsolated);
      const run = (url: string) =>
        page.evaluate(
          ({ worker: src, list }) =>
            new Promise<Record<string, Result>>((resolve) => {
              const worker = new Worker(src, { type: "module" });
              worker.addEventListener("message", (e) => resolve(e.data));
              worker.addEventListener("error", (e) => resolve({ worker: { error: e.message } }));
              worker.postMessage(list);
            }),
          { worker: url, list: names },
        );

      results = await run("/test/demux.worker.js");
      transferred = await run("/test/demux.worker.js?transfer");
    }, 120_000);
    afterAll(() => browser?.close());

    test("page is cross-origin isolated", () => expect(isolated).toBe(true));
    test("a decoder asking for more threads than the pool fails", () =>
      expect(results.threadPool as unknown).toBe("rejected"));
    test("a subtitle decoder refuses packets and frames", () =>
      expect(results.subtitleDecoder as unknown).toBe("rejected"));
    test("a flushed resampler starts afresh", () =>
      expect(results.resampleTwice as unknown).toBe("same"));

    for (const name of names) {
      test(name, () => {
        const { streams = [], ...rest } = results[name] ?? {};
        const { streams: want = [], ...wantRest } = fixtures[name] ?? {};
        expect(rest).toEqual({ ...wantRest, rewind: "ok" });
        expect(streams.map(withoutSamples)).toEqual(want.map(withoutSamples));

        for (const [i, s] of streams.entries()) {
          const w = want[i]?.audio;
          if (s.audio && w) expect(audioDiff(s.audio, w)).toBeLessThanOrEqual(FLOAT_TOLERANCE);

          if (s.audio?.resampled && w?.resampled) {
            expect(s.audio.resampled.samples).toBe(w.resampled.samples);
            const diff = probeDiff(s.audio.resampled.probe, w.resampled.probe);
            expect(diff).toBeLessThanOrEqual(FLOAT_TOLERANCE);
          }

          // Every decoded frame, converted, must be something WebCodecs can display.
          if (s.video) expect(s.video.videoFrame).toBe("ok");
        }

        // Copying a stream to another module must not change a single sample.
        expect(transferred[name]).toEqual(results[name]);
      });
    }
  });
}

// A stream with its decoded output reduced to what must match exactly: decoded video
// entirely, audio but for its float samples.
function withoutSamples({ audio, video, ...stream }: Stream): Stream {
  if (video) {
    const { videoFrame: _, ...v } = video;
    return { ...stream, video: v };
  }

  if (!audio) return stream;
  const { frames, samples, firstPts } = audio;
  return { ...stream, audio: { frames, samples, firstPts, sha256: "" } };
}

// The largest difference between decoded and native samples: 0 when the output is
// identical, Infinity when an integer decoder differs at all.
function audioDiff(actual: NonNullable<Stream["audio"]>, want: NonNullable<Stream["audio"]>) {
  if (actual.sha256 === want.sha256) return 0;

  if (want.exact || !actual.probe || !want.probe) return Number.POSITIVE_INFINITY;
  return probeDiff(actual.probe, want.probe);
}

// The largest difference between probed values and native FFmpeg's, base64 float32.
function probeDiff(actual: string | number[], want: string | number[]) {
  if (typeof want !== "string" || !Array.isArray(actual)) return Number.POSITIVE_INFINITY;
  const bytes = Buffer.from(want, "base64");
  const native = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  if (native.length !== actual.length) return Number.POSITIVE_INFINITY;
  let max = 0;

  for (const [i, v] of native.entries()) max = Math.max(max, Math.abs(v - (actual[i] ?? 0)));

  return max;
}
