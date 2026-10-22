// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// WebCodecs decoder configs (src/codec.ts) in Chromium, Firefox and WebKit: for every
// fixture, the browser's VideoDecoder takes the config made from the media worker's
// parameters and the first packet, unless it lacks the codec (UNSUPPORTED), and decodes that
// packet to frame 0; the codec string is the one native FFmpeg writes, where it writes one
// (test/fixtures/expected.json). The same holds for the stream as it would be without a
// configuration record (MPEG-TS, raw streams): Annex B, its parameter sets in band.
// Usage: bun run test.

import { afterAll, describe, expect, test } from "bun:test";
import { browsers } from "./support/browsers";
import { MEDIA_WORKER, PAGE, serveEngine } from "./support/serve";

const expected: Record<string, { video: { id: number; codec: string; codecString?: string } }> =
  await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const files = Object.entries(expected).map(([name, e]) => ({ name, stream: e.video.id }));
// What each browser's WebCodecs cannot decode; the engine's own decoders are for these.
const UNSUPPORTED: Record<string, string[]> = { firefox: ["hevc"] };
// What it decodes only in hardware, which a machine may lack while the browser still says it
// decodes it: CI's virtual runners report a hardware AV1 decoder they lack, so Playwright's
// WebKit says it supports AV1 and then fails to decode it.
const HARDWARE: Record<string, string[]> = { webkit: ["av1"] };
const server = await serveEngine("<!doctype html><title>test</title>");

afterAll(() => server.stop(true));

for (const [name, [type, options]] of Object.entries(browsers)) {
  describe(name, () => {
    test("decodes the first frame of every fixture with the config the engine makes", async () => {
      const browser = await type.launch(options);

      try {
        const tab = await browser.newPage();
        await tab.goto(server.url.href);

        const checked = await tab.evaluate(
          async ({ page, worker, all }) => {
            const support: typeof import("./support/page") = await import(page);
            const media = support.startMedia(worker);
            type Checked = Awaited<ReturnType<typeof support.checkVideoConfig>>;
            // An error names its fixture instead of ending the run.
            const results: Record<string, Checked | { error: string }> = {};

            for (const { name: n, stream } of all) {
              const res = await fetch(`/test/fixtures/${n}`);
              const blob = await res.blob();
              const opened = await media.request({ type: "open", file: new File([blob], n) });
              if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
              const params = opened.video[stream];
              if (!params) throw new Error(`${n}: no parameters for stream ${stream}`);
              const keyframe = await support.firstPacket(media, stream);

              try {
                results[n] = await support.checkVideoConfig(params, keyframe);
              } catch (e) {
                results[n] = { error: String(e) };
              }
            }

            media.stop();
            return results;
          },
          { page: PAGE, worker: MEDIA_WORKER, all: files },
        );

        for (const [file, { video }] of Object.entries(expected)) {
          const got = checked[file];
          if (!got) throw new Error(`${file}: not checked`);

          if ("error" in got) {
            const hardware = HARDWARE[name]?.includes(video.codec);
            if (hardware && got.error.startsWith("EncodingError")) continue;
            throw new Error(`${file}: ${got.error}`);
          }

          const supported = !UNSUPPORTED[name]?.includes(video.codec);
          expect(got.supported, `${file} ${got.codec} supported`).toBe(supported);
          expect(got.id, `${file} first frame`).toBe(supported ? 0 : undefined);
          expect(got.inBandId, `${file} first frame in band`).toBe(supported ? 0 : undefined);
          // A record names HEVC hvc1 (parameter sets out of band), parameter sets in band hev1.
          expect(got.inBandCodec, `${file} in band`).toBe(got.codec.replace(/^hvc1/, "hev1"));

          if (video.codecString) {
            expect(got.codec.toLowerCase(), `${file} codec`).toBe(video.codecString.toLowerCase());
          }
        }
      } finally {
        await browser.close();
      }
    }, 120_000);
  });
}
