// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// engine.play and engine.pause in Chromium, Firefox and WebKit, in real time, through the
// public API alone: while sync-10min.mp4 plays, the frame on the canvas is, at every animation
// frame, the one due at engine.currentTime, the media time being heard, within MAX_OFFSET; and
// a pause holds both the frame and the clock, on the frame due then or up to two after
// (see the check). The canvas belongs to the render worker, so the
// page reads what it shows by drawing it. It plays for SNOWY_SYNC_SECONDS (default 20); the
// ten-minute run is `SNOWY_SYNC_SECONDS=600 bun test test/play.test.ts`.
// Usage: bun run test.

import { afterAll, describe, expect, test } from "bun:test";
import { browsers } from "./support/browsers";
import { ENTRY, PAGE, serveEngine } from "./support/serve";

const FILE = "sync-10min.mp4";
const expected: Record<
  string,
  { video: { timeBase: string; width: number; height: number; pts: number[] } }
> = await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const video = expected[FILE]?.video ?? { timeBase: "1/1", width: 0, height: 0, pts: [] };
const SECONDS = Number(process.env.SNOWY_SYNC_SECONDS ?? 20);
// How far the frame on screen may be from the one due at the media time heard, in seconds.
const MAX_OFFSET = 0.02;
// How late a frame may look in Firefox, whose canvas reads back up to four frames stale.
const STALE_LATE = 0.15;
const server = await serveEngine(
  `<!doctype html><title>test</title><canvas width="${video.width}" height="${video.height}"></canvas>`,
);

afterAll(() => server.stop(true));

// How far `time` is from the time frame `id` is due, in seconds: 0 while it is due, negative
// while it is early, positive once it is late.
function offset(id: number, time: number) {
  const [num = 1, den = 1] = video.timeBase.split("/").map(Number);
  const due = ((video.pts[id] ?? 0) * num) / den;
  const next = ((video.pts[id + 1] ?? Infinity) * num) / den;
  if (time < due) return time - due;
  return time >= next ? time - next : 0;
}

// Seconds as milliseconds to a tenth, for the log.
const ms = (x: number) => Math.round(x * 1e4) / 10;

// The frame due at `time`.
function frameAt(time: number) {
  const [num = 1, den = 1] = video.timeBase.split("/").map(Number);
  const after = video.pts.findIndex((pts) => (pts * num) / den > time);
  return (after < 0 ? video.pts.length : after) - 1;
}

for (const [name, [type, options]] of Object.entries(browsers)) {
  describe(name, () => {
    test(
      `plays ${FILE} with the frame on screen at the time heard`,
      async () => {
        const browser = await type.launch(options);

        try {
          const tab = await browser.newPage();
          await tab.goto(server.url.href);
          // A user gesture, so audio may start.
          await tab.mouse.click(1, 1);
          const got = await tab.evaluate(
            async ({ entry, page, file, seconds }) => {
              const engine: typeof import("../src/index") = await import(entry);
              const support: typeof import("./support/page") = await import(page);
              const canvas = document.querySelector("canvas");
              if (!canvas) throw new Error("no canvas");
              const player = await engine.createEngine({ canvas });
              const res = await fetch(`/test/fixtures/${file}`);
              const blob = await res.blob();
              await player.open(new File([blob], file));
              await player.play();
              const playing = await support.watchScreen(player, canvas, seconds * 1000);
              await player.pause();
              // A frame for the render worker to see the pause, then a second paused.
              await support.watchScreen(player, canvas, 50);
              const paused = await support.watchScreen(player, canvas, 1000);
              player.close();
              return { playing, paused };
            },
            { entry: ENTRY, page: PAGE, file: FILE, seconds: SECONDS },
          );

          // Firefox now and then reads back the canvas as it was up to four frames ago. The
          // frame queue only moves forward, so a frame older than one already read was not on
          // screen; the newest frame read is always checked, so this hides no frame ahead. More
          // of them come under load (4 % locally, 6 % on CI); most reads must still be checked.
          const firefox = name === "firefox";
          const newest = { id: -1 };
          const checked = got.playing.filter(([, id]) => {
            const stale = firefox && id < newest.id;
            newest.id = Math.max(newest.id, id);
            return !stale;
          });
          expect(got.playing.length - checked.length).toBeLessThan(got.playing.length / 4);
          const early = { offset: 0, time: 0, id: 0 };
          const late = { offset: 0, time: 0, id: 0 };

          for (const [time, id] of checked) {
            const o = offset(id, time);
            if (o < early.offset) Object.assign(early, { offset: o, time, id });
            if (o > late.offset) Object.assign(late, { offset: o, time, id });
          }

          const sorted = checked
            .map(([time, id]) => Math.abs(offset(id, time)))
            .toSorted((a, b) => a - b);
          const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
          const of = (w: typeof early) => `${w.offset} s, frame ${w.id} at ${w.time} s`;
          const p = (q: number) => ms(sorted[Math.floor(sorted.length * q)] ?? 0);
          // A summary for the log, so a failure on CI shows its shape.
          console.log(
            `${name}: ${checked.length} reads, ${got.playing.length - checked.length} stale;`,
            `|offset| p50 ${p(0.5)} p95 ${p(0.95)} p99 ${p(0.99)} ms;`,
            `early ${ms(early.offset)} ms at ${ms(early.time) / 1000} s;`,
            `late ${ms(late.offset)} ms at ${ms(late.time) / 1000} s;`,
            `over ${sorted.filter((x) => x >= MAX_OFFSET).length};`,
            `last ${ms(got.playing.at(-1)?.[0] ?? 0) / 1000} s`,
          );

          const last = got.playing.at(-1)?.[0] ?? 0;
          // It played in real time, from the start.
          expect(last).toBeGreaterThan(SECONDS - 1);
          expect(last).toBeLessThan(SECONDS + 0.5);
          // No frame early: a stale read cannot make one look early, in any browser.
          expect(-early.offset, `early by ${of(early)}`).toBeLessThan(MAX_OFFSET);
          // No frame late, but in Firefox, where a stale read of the newest frame looks late.
          // There, nearly every frame is in time, and none looks later than a stale read.
          expect(late.offset, `late by ${of(late)}`).toBeLessThan(
            firefox ? STALE_LATE : MAX_OFFSET,
          );
          expect(p99, "the 99th percentile").toBeLessThan(MAX_OFFSET);
          // Paused: one time, one frame.
          expect(new Set(got.paused.map(([time]) => time)).size).toBe(1);
          expect(new Set(got.paused.map(([, id]) => id)).size).toBe(1);
          const [[pausedAt, pausedId] = [0, 0]] = got.paused;
          // The frame due then, or one or two after: the last one shown was for a refresh later,
          // and Firefox's output timestamp falls back by its output latency as it suspends.
          expect([0, 1, 2], `paused at ${pausedAt} on frame ${pausedId}`).toContain(
            pausedId - frameAt(pausedAt),
          );
        } finally {
          await browser.close();
        }
      },
      (SECONDS + 60) * 1000,
    );
  });
}
