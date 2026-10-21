// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// engine.play and engine.pause in Chromium, Firefox and WebKit, in real time, through the
// public API alone: while sync-10min.mp4 plays, the frame on the canvas is, at every animation
// frame, the one due at engine.currentTime, the media time being heard, within MAX_OFFSET; and
// a pause holds both the frame and the clock, on the frame due then or up to two after
// (see the check). The canvas belongs to the render worker, so the
// page reads what it shows by drawing it. It plays for SNOWY_SYNC_SECONDS (default 20); the
// ten-minute run is `SNOWY_SYNC_SECONDS=600 bun test test/play.test.ts`. And play starts
// where video or audio gets no further, and goes on after a pause, with the frame due shown.
// Usage: bun run test.

import { afterAll, describe, expect, test } from "bun:test";
import { PCM_RATE } from "./support/audio";
import { browsers } from "./support/browsers";
import { ENTRY, PAGE, serveEngine } from "./support/serve";

interface Video {
  timeBase: string;
  width: number;
  height: number;
  pts: number[];
}

const FILE = "sync-10min.mp4";

const expected: Record<string, { video: Video; audio: { resampled: { frames: number } } }> =
  await Bun.file(new URL("fixtures/expected.json", import.meta.url)).json();
const video = expected[FILE]?.video ?? { timeBase: "1/1", width: 0, height: 0, pts: [] };
// Where play starts as video waits for packets, where it starts at the end of the audio, and
// the long one; each is played, paused and played on, for WATCH seconds a play.
const SPARSE = "sparse-h264-aac.mp4";
const STARTS = [SPARSE, "short-audio-h264-aac.mp4", FILE];
const WATCH = 2;
// How far a play's clock at its last read may be from WATCH seconds on from where it started,
// in seconds: play resolves, and the watch begins, under 0.15 s after the clock starts.
const REAL_TIME = 0.25;
const SECONDS = Number(process.env.SNOWY_SYNC_SECONDS ?? 20);
// How far the frame on screen may be from the one due at the media time heard, in seconds.
const MAX_OFFSET = 0.02;
// How late a frame may look in Firefox, whose canvas reads back up to four frames stale.
const STALE_LATE = 0.15;
// On CI's virtual machines the GPU does not draw in real time (Chromium's page gets 30
// animation frames a second), so video falls behind: p99 82 ms in Chromium, up to three
// quarters of a second at worst. And when the machine stalls, Firefox's output timestamp jumps
// as it catches up, so a frame looks early by up to 86 ms. There, the offsets are bounded by
// these, and logged; the bounds above hold on real hardware.
const CI_LATE = 1;
const CI_EARLY = 0.15;
const CI_P99 = 0.15;
// And Firefox's audio output stalls there: its clock ends 0.3 to 1.2 s short over 20 s, where
// it ends within 0.1 s on real hardware. So on CI Firefox may lose two seconds; other browsers,
// and every browser off CI, one.
const CI_FIREFOX_LOST = 2;
// And over a two-second play, the clock may be as far off as a frame may be late.
const CI_REAL_TIME = CI_LATE;
const ci = process.env.CI === "true";
const realTime = ci ? CI_REAL_TIME : REAL_TIME;
// The bounds on a frame early and late, in seconds, in browser `name`.
const earliness = ci ? CI_EARLY : MAX_OFFSET;
const lateness = (name: string) => (ci ? CI_LATE : name === "firefox" ? STALE_LATE : MAX_OFFSET);
const server = await serveEngine(
  `<!doctype html><title>test</title><canvas width="${video.width}" height="${video.height}"></canvas>`,
);

afterAll(() => server.stop(true));

// How far `time` is from the time frame `id` of `v` is due, in seconds: 0 while it is due,
// negative while it is early, positive once it is late.
function offset(v: Video, id: number, time: number) {
  const [num = 1, den = 1] = v.timeBase.split("/").map(Number);
  const due = ((v.pts[id] ?? 0) * num) / den;
  const next = ((v.pts[id + 1] ?? Infinity) * num) / den;
  if (time < due) return time - due;
  return time >= next ? time - next : 0;
}

// Seconds as milliseconds to a tenth, for the log.
const ms = (x: number) => Math.round(x * 1e4) / 10;
// The reads of a play, for the log.
const span = (reads: [time: number, id: number][]) =>
  `${reads.length} reads, from ${reads[0]?.[0]} s to ${reads.at(-1)?.[0]} s`;

// The frame of `v` due at `time`.
function frameAt(v: Video, time: number) {
  const [num = 1, den = 1] = v.timeBase.split("/").map(Number);
  const after = v.pts.findIndex((pts) => (pts * num) / den > time);
  return (after < 0 ? v.pts.length : after) - 1;
}

// The reads of a play to check. Firefox now and then reads back the canvas as it was up to four
// frames ago. The frame queue only moves forward, so a frame older than one already read was
// not on screen; the newest frame read is always checked, so this hides no frame ahead. The
// first read, in Firefox and now and then in Chromium, may show a frame from five or more
// frames before, with the frame due on the next read under a millisecond later in Chromium.
// That is no late frame: play prerolls a quarter second of video before the clock starts. So
// the first read is left out in every browser.
function fresh(reads: [time: number, id: number][], firefox: boolean) {
  const newest = { id: -1 };
  return reads.filter(([, id], i) => {
    const stale = i === 0 || (firefox && id < newest.id);
    newest.id = Math.max(newest.id, id);
    return !stale;
  });
}

for (const [name, [type, options]] of Object.entries(browsers)) {
  describe(name, () => {
    const firefox = name === "firefox";

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

          // Stale reads come more under load (4 % locally, 6 % on CI); most reads must still be
          // checked.
          const checked = fresh(got.playing, firefox);
          expect(got.playing.length - checked.length).toBeLessThan(got.playing.length / 10);
          const early = { offset: 0, time: 0, id: 0 };
          const late = { offset: 0, time: 0, id: 0 };

          for (const [time, id] of checked) {
            const o = offset(video, id, time);
            if (o < early.offset) Object.assign(early, { offset: o, time, id });
            if (o > late.offset) Object.assign(late, { offset: o, time, id });
          }

          const sorted = checked
            .map(([time, id]) => Math.abs(offset(video, id, time)))
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
          expect(last).toBeGreaterThan(SECONDS - (ci && firefox ? CI_FIREFOX_LOST : 1));
          // Watching ends on an animation frame, which may come late on CI.
          expect(last).toBeLessThan(SECONDS + 1);
          // No frame early: a stale read cannot make one look early, in any browser.
          expect(-early.offset, `early by ${of(early)}`).toBeLessThan(earliness);
          // No frame late, but in Firefox, where a stale read of the newest frame looks late.
          // There, nearly every frame is in time, and none looks later than a stale read.
          const start = got.playing.slice(0, 8).map(([time, id]) => `${ms(time)}:${id}`);
          expect(late.offset, `late by ${of(late)}; first reads ${start.join(" ")}`).toBeLessThan(
            lateness(name),
          );
          expect(p99, "the 99th percentile").toBeLessThan(ci ? CI_P99 : MAX_OFFSET);
          // Paused: one time, one frame.
          expect(new Set(got.paused.map(([time]) => time)).size).toBe(1);
          expect(new Set(got.paused.map(([, id]) => id)).size).toBe(1);
          const [[pausedAt, pausedId] = [0, 0]] = got.paused;
          // The frame due then, or one or two after: the last one shown was for a refresh later,
          // and Firefox's output timestamp falls back by its output latency as it suspends.
          expect([0, 1, 2], `paused at ${pausedAt} on frame ${pausedId}`).toContain(
            pausedId - frameAt(video, pausedAt),
          );
        } finally {
          await browser.close();
        }
      },
      (SECONDS + 60) * 1000,
    );

    test(`starts, pauses and plays on ${STARTS.join(", ")}`, async () => {
      const browser = await type.launch(options);

      try {
        const tab = await browser.newPage();
        await tab.goto(server.url.href);
        await tab.mouse.click(1, 1);
        const got = await tab.evaluate(
          async ({ entry, page, files, seconds }) => {
            const engine: typeof import("../src/index") = await import(entry);
            const support: typeof import("./support/page") = await import(page);
            const canvas = document.querySelector("canvas");
            if (!canvas) throw new Error("no canvas");
            const player = await engine.createEngine({ canvas });
            const plays = [];

            for (const file of files) {
              const res = await fetch(`/test/fixtures/${file}`);
              const blob = await res.blob();
              await player.open(new File([blob], file));
              await player.play();
              const first = await support.watchScreen(player, canvas, seconds * 1000);
              await player.pause();
              await support.watchScreen(player, canvas, 50);
              const paused = await support.watchScreen(player, canvas, 300);
              await player.play();
              const second = await support.watchScreen(player, canvas, seconds * 1000);
              plays.push({ first, paused, second });
            }

            player.close();
            return plays;
          },
          { entry: ENTRY, page: PAGE, files: STARTS, seconds: WATCH },
        );

        for (const [i, file] of STARTS.entries()) {
          const { video: v, audio } = expected[file] ?? {};
          const play = got[i];
          if (!v || !audio || !play) throw new Error(`no ${file}`);
          const end = audio.resampled.frames / PCM_RATE;
          const [[pausedAt, pausedId] = [0, 0]] = play.paused;
          console.log(
            `${name} ${file}: ${span(play.first)}; paused at ${pausedAt} s; ${span(play.second)}`,
          );
          // Started, and played from the start in real time, up to the end of the audio.
          expect(Math.abs((play.first.at(-1)?.[0] ?? 0) - Math.min(end, WATCH))).toBeLessThan(
            realTime,
          );
          // Paused: one time, one frame.
          expect(new Set(play.paused.map(([time]) => time)).size).toBe(1);
          expect(new Set(play.paused.map(([, id]) => id)).size).toBe(1);
          // On the frame due then, or one or two after, as in the test above.
          expect([0, 1, 2], `${file} paused at ${pausedAt} on frame ${pausedId}`).toContain(
            pausedId - frameAt(v, pausedAt),
          );
          // Played on from where it paused.
          const resumed = play.second[0]?.[0] ?? 0;
          expect(resumed).toBeGreaterThanOrEqual(pausedAt);
          expect(resumed - pausedAt).toBeLessThan(realTime);
          expect(
            Math.abs((play.second.at(-1)?.[0] ?? 0) - Math.min(end, pausedAt + WATCH)),
          ).toBeLessThan(realTime);

          // Each frame due on screen as it plays.
          for (const [phase, reads] of Object.entries({ first: play.first, second: play.second })) {
            const checked = fresh(reads, firefox);
            expect(checked.length, `${file} ${phase}: reads checked`).toBeGreaterThan(
              reads.length * 0.9,
            );

            for (const [time, id] of checked) {
              const o = offset(v, id, time);
              const at = `${file} ${phase}: frame ${id} at ${time} s`;
              expect(-o, at).toBeLessThan(earliness);
              expect(o, at).toBeLessThan(lateness(name));
            }
          }
        }
      } finally {
        await browser.close();
      }
    }, 60_000);

    // The decoder lets out sparse video's last frames only once it is flushed, at the END
    // record, so the demuxer reads ahead of the audio to reach it before they are due.
    test(`plays ${SPARSE} to the end with each frame on time`, async () => {
      const browser = await type.launch(options);

      try {
        const tab = await browser.newPage();
        await tab.goto(server.url.href);
        await tab.mouse.click(1, 1);
        const { video: v, audio } = expected[SPARSE] ?? {};
        if (!v || !audio) throw new Error(`no ${SPARSE}`);
        const end = audio.resampled.frames / PCM_RATE;
        const reads = await tab.evaluate(
          async ({ entry, page, file, watch }) => {
            const engine: typeof import("../src/index") = await import(entry);
            const support: typeof import("./support/page") = await import(page);
            const canvas = document.querySelector("canvas");
            if (!canvas) throw new Error("no canvas");
            const player = await engine.createEngine({ canvas });
            const res = await fetch(`/test/fixtures/${file}`);
            const blob = await res.blob();
            await player.open(new File([blob], file));
            await player.play();
            const watched = await support.watchScreen(player, canvas, watch);
            player.close();
            return watched;
          },
          // Half a second past the end, so the last frame is read at the end.
          { entry: ENTRY, page: PAGE, file: SPARSE, watch: (end + 0.5) * 1000 },
        );

        console.log(`${name} ${SPARSE}: ${span(reads)}`);
        expect(Math.abs((reads.at(-1)?.[0] ?? 0) - end)).toBeLessThan(realTime);
        expect(reads.at(-1)?.[1]).toBe(v.pts.length - 1);

        for (const [time, id] of fresh(reads, firefox)) {
          const o = offset(v, id, time);
          expect(-o, `frame ${id} at ${time} s`).toBeLessThan(earliness);
          expect(o, `frame ${id} at ${time} s`).toBeLessThan(lateness(name));
        }
      } finally {
        await browser.close();
      }
    }, 60_000);
  });
}
