// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// WebCodecs decoder configs (src/codec.ts) in Chromium: every fixture has a decoder, and for
// every fixture WebCodecs decodes, the browser's VideoDecoder takes the config made from the
// media worker's parameters and the first packet, and decodes that packet to frame 0, in the
// colour the file states (as ffprobe names it, test/fixtures/expected.json); the codec
// string is the one native FFmpeg writes, where it writes one (test/fixtures/expected.json).
// The same holds for the stream as it would be without a configuration record (MPEG-TS, raw
// streams): Annex B, its parameter sets in band.
// Usage: bun run test.

import { afterAll, expect, test } from "bun:test";
import { decodable, launch } from "./support/browsers";
import { MEDIA_WORKER, PAGE, serveEngine } from "./support/serve";

interface Colour {
  primaries: string;
  transfer: string;
  matrix: string;
  range: string;
}

const generated = await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const expected: Record<
  string,
  { video: { id: number; codec: string; codecString?: string; colour: Colour } }
> = decodable(generated);
const files = Object.entries(expected).map(([name, e]) => ({
  name,
  stream: e.video.id,
  colour: e.video.colour,
}));
const server = await serveEngine("<!doctype html><title>test</title>");

afterAll(() => server.stop(true));

test("decodes the first frame of every fixture with the config the engine makes", async () => {
  const browser = await launch();

  try {
    const tab = await browser.newPage();
    await tab.goto(server.url.href);

    const checked = await tab.evaluate(
      async ({ page, worker, all }) => {
        const support: typeof import("./support/page") = await import(page);
        const media = support.startMedia(worker);
        type Checked = Awaited<ReturnType<typeof support.checkVideoConfig>>;
        // An error names its fixture instead of ending the run.
        const results: Record<string, Checked | { error: string } | { decoder: string }> = {};

        for (const { name: n, stream, colour } of all) {
          const res = await fetch(`/test/fixtures/${n}`);
          const blob = await res.blob();
          const opened = await media.request({ type: "open", file: new File([blob], n) });
          if (opened.type !== "opened") throw new Error(`${n}: ${opened.type}`);
          const params = opened.video[stream];
          if (!params) throw new Error(`${n}: no parameters for stream ${stream}`);

          // An FFmpeg module decodes it (test/render.test.ts).
          if (params.decoder !== "webcodecs") {
            results[n] = { decoder: params.decoder };
            continue;
          }

          const keyframe = await support.firstPacket(media, stream);

          try {
            results[n] = await support.checkVideoConfig(params, keyframe, colour);
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

      if ("error" in got) throw new Error(`${file}: ${got.error}`);

      if ("decoder" in got) {
        // QuickTime RLE is the one in video-ext.
        const module = video.codec === "qtrle" ? "video-ext" : "video";
        expect(got.decoder, `${file} decoder`).toBe(module);
        continue;
      }

      expect(got.supported, `${file} ${got.codec} supported`).toBe(true);
      expect(got.id, `${file} first frame`).toBe(0);

      // The decoded frame carries the colour the file states.
      expect(got.colour, `${file} colour`).toMatchObject(got.stated ?? {});

      expect(got.inBandId, `${file} first frame in band`).toBe(0);
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
