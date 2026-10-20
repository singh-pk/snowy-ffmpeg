// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The public API of @snowy-media/engine.

import { createAudioOutput } from "./audio";
import type { VideoParams } from "./codec";
import { createPcmControl, createPcmRing } from "./pcm";
import { checkMainThread, UnsupportedPlatformError } from "./platform";
import type { FromMedia, FromRender, MediaInfo, ToMedia, ToRender } from "./protocol";
import { closeRing, createRing, RING_CAPACITY } from "./ring";

export { UnsupportedPlatformError } from "./platform";
export type { MediaInfo, PlatformFeature, Track } from "./protocol";

export interface EngineOptions {
  /** The canvas the engine draws video into; the engine takes control of it. */
  canvas: HTMLCanvasElement;
}

export interface Engine {
  /** Opens `file` in place of the open one, stopping it, and resolves with what it holds. */
  open(file: File): Promise<MediaInfo>;
  /**
   * Plays the open file's first video and first audio track from where it is, once the
   * browser allows audio to start (after a user gesture), unless a pause comes first: once
   * video is decoded and audio buffered ahead, it starts the audio, and resolves once
   * it is heard. Rejects if playing has failed, or with an AbortError if an open stops it
   * while it starts.
   */
  play(): Promise<void>;
  /** Pauses; `play` goes on from here. Rejects if playing has failed. */
  pause(): Promise<void>;
  /** The media time, in seconds, of what is being heard and seen now. */
  readonly currentTime: number;
  /** Stops the engine's workers. */
  close(): void;
}

// The PCM ring's length at `rate`: a power of two, a second and more, so the media worker
// can demux a second of video ahead of the audio it decodes (docs/architecture.md#playback).
const pcmFrames = (rate: number) => 2 ** Math.ceil(Math.log2(rate));
// The packet ring of a file without video, which only ever carries the END record.
const NO_VIDEO_RING = 64;
// The audio buffered before it starts, in seconds, so a slow start does not underrun.
const PREROLL = 0.25;
// The output timestamp has settled once this many in a row, each newer than the last, map
// context time to performance time within SETTLED_MS of the one before. The first ones
// after output starts are estimates: Chromium's move by 35 ms, Firefox's by 10 ms. Coarse
// timers may never agree, so it settles anyway after SETTLED_LIMIT newer ones.
const SETTLED_COUNT = 2;
const SETTLED_MS = 2;
const SETTLED_LIMIT = 10;
// What the PCM ring mixes to; the context's destination takes stereo everywhere.
const CHANNELS = 2;

// A hidden page starts no audio: its animation frames, and so video, wait until it is shown.
const visible = () => document.visibilityState === "visible";

// A worker that fails to load fires a plain Event, without a message.
const loadError = (e: Event, worker: string) =>
  new Error(e instanceof ErrorEvent ? e.message : `the ${worker} worker failed to load`);

// Sends `message` to `worker` and resolves with its reply, or rejects if the worker fails to load.
function request(worker: Worker, message: ToRender, transfer: Transferable[]) {
  return new Promise<FromRender>((resolve, reject) => {
    worker.addEventListener("message", (e: MessageEvent<FromRender>) => resolve(e.data), {
      once: true,
    });
    worker.addEventListener("error", (e) => reject(loadError(e, "render")), { once: true });
    worker.postMessage(message, transfer);
  });
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// The media worker, as a function per request; replies may come in any order. `buffered`
// runs when a demux request says its audio is buffered.
function createMedia() {
  const worker = new Worker(new URL("./media.worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, PromiseWithResolvers<FromMedia> & { buffered(): void }>();
  let next = 0;
  // Once set, why every request rejects: the worker failed to load, or the engine closed.
  let failed: Error | undefined;

  worker.addEventListener("message", ({ data }: MessageEvent<FromMedia>) => {
    const call = pending.get(data.id);

    if (data.type === "buffered") {
      call?.buffered();
      return;
    }

    pending.delete(data.id);
    if (data.type === "error") call?.reject(new Error(data.message));
    else call?.resolve(data);
  });

  function fail(error: Error) {
    failed ??= error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  }

  worker.addEventListener("error", (e) => fail(loadError(e, "media")));

  function send(
    message: DistributiveOmit<ToMedia, "id">,
    transfer: Transferable[] = [],
    buffered = () => {},
  ) {
    if (failed) return Promise.reject(failed);
    const call = Promise.withResolvers<FromMedia>();
    const id = next++;
    pending.set(id, { ...call, buffered });
    worker.postMessage({ ...message, id }, transfer);
    return call.promise;
  }

  function close() {
    worker.terminate();
    fail(new Error("the engine is closed"));
  }

  return { send, close };
}

/**
 * Starts an engine that draws into `canvas`. Rejects with an UnsupportedPlatformError naming
 * the first missing feature when the browser cannot run it.
 */
export async function createEngine({ canvas }: EngineOptions): Promise<Engine> {
  const missing = checkMainThread();
  if (missing) throw new UnsupportedPlatformError(missing);
  // Throws if the canvas is already in use, before there is a worker to stop.
  const offscreen = canvas.transferControlToOffscreen();
  const render = new Worker(new URL("./render.worker.js", import.meta.url), { type: "module" });
  // Starts loading FFmpeg while the render worker checks the GPU.
  const media = createMedia();

  try {
    const reply = await request(render, { type: "init", canvas: offscreen }, [offscreen]);
    if (reply.type === "unsupported") throw new UnsupportedPlatformError(reply.missing);
  } catch (e) {
    render.terminate();
    media.close();
    throw e;
  }

  return createPlayer(render, media);
}

// What plays: play `id`, its clock, publishing the output timestamp now, whether it may
// start and is heard, and stopping it.
interface Playback {
  id: number;
  clock: ReturnType<typeof createPcmControl>;
  publish(): void;
  primed(): boolean;
  heard(): boolean;
  stop(): void;
}

// The engine on a render worker that is ready and a media worker.
function createPlayer(render: Worker, media: ReturnType<typeof createMedia>): Engine {
  const state = {
    opened: undefined as { info: MediaInfo; video: Record<number, VideoParams> } | undefined,
    // Made on the first play, and kept: a page may only start so many.
    context: undefined as AudioContext | undefined,
    // Set at once, so a second play while the first starts joins it.
    playback: undefined as Promise<Playback> | undefined,
    // What plays, once it has started.
    started: undefined as Playback | undefined,
    // Why playing stopped, until the next open.
    failure: undefined as Error | undefined,
    // The id of what plays, whose failures count, or -1; and the next one.
    current: -1,
    next: 0,
    // Whether the last call was play, not pause.
    playing: false,
    // How far the render worker has decoded, as it last reported, and for which play.
    video: { id: -1, ahead: false, stuck: false, shown: false },
    closed: false,
  };
  // Wakes the waits of `until`.
  const waits = new Set<() => void>();

  // Has each wait of `until` look again; on every event that may change what it waits for.
  function changed() {
    for (const wake of waits) wake();
  }

  // Resolves once `done` returns true, which it checks now and on each change.
  async function until(done: () => boolean) {
    while (!done()) {
      const woken = Promise.withResolvers<void>();
      waits.add(woken.resolve);

      try {
        await woken.promise;
      } finally {
        waits.delete(woken.resolve);
      }
    }
  }

  document.addEventListener("visibilitychange", changed);

  render.addEventListener("message", ({ data }: MessageEvent<FromRender>) => {
    if (data.type === "video") state.video = data;
    if (data.type === "error" && data.id === state.current) fail(new Error(data.message));
    changed();
  });
  // An uncaught error in the render worker.
  render.addEventListener("error", (e) => fail(loadError(e, "render")));

  function fail(error: Error) {
    state.failure ??= error;
    stop();
  }

  // Starts the open file playing into `context` from its start, as play `id`.
  async function startPlayback(context: AudioContext, id: number): Promise<Playback> {
    const opened = state.opened;
    if (!opened) throw new Error("play: no file is open");
    const audio = opened.info.tracks.find((t) => t.kind === "audio");
    // Video-only files need a clock without audio; they come later.
    if (!audio) throw new Error("play: a file without audio does not play yet");
    const video = opened.info.tracks.find((t) => t.kind === "video");
    const params = video && opened.video[video.id];
    const frames = pcmFrames(context.sampleRate);
    const pcm = createPcmRing(frames, CHANNELS, context.sampleRate);
    const clock = createPcmControl(pcm);
    // Held while it prerolls: a context made in a user gesture starts running by itself, and
    // one that played the last file still runs.
    await context.suspend();
    const node = await createAudioOutput(context, pcm);

    // An open may have stopped this play while the worklet loaded, and the media worker may
    // hold another file already.
    if (state.current !== id) {
      clock.close();
      node.disconnect();
      throw new DOMException("play: stopped while it started", "AbortError");
    }

    const ring = createRing(params ? RING_CAPACITY : NO_VIDEO_RING);
    const wake = new MessageChannel();

    if (params) {
      const message = { type: "play", id, ring, wake: wake.port2, params, pcm } as const;
      render.postMessage(message satisfies ToRender, [wake.port2]);
    } else {
      wake.port2.close();
    }

    const streams = video && params ? [video.id] : [];
    const preroll = PREROLL * context.sampleRate;
    const demux = { buffered: false, done: false };

    const demuxed = media.send(
      { type: "demux", ring, wake: wake.port1, streams, audio: { stream: audio.id, pcm, preroll } },
      [wake.port1],
      () => {
        demux.buffered = true;
        changed();
      },
    );

    const frame = { id: 0 };
    // The last output timestamp, as context minus performance milliseconds, and when.
    const output = { offset: Number.NaN, at: 0, agreed: 0, newer: 0, settled: false };

    // The output timestamp, for the render worker (src/pcm.ts), on every animation frame and
    // as the context stops. It runs once it has settled, and stays so until the context stops:
    // Firefox's then wanders by a few milliseconds, which is no reason to stop the clock.
    function publish() {
      const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
      const offset = contextTime * 1000 - performanceTime;

      if (performanceTime > output.at) {
        const agrees = Math.abs(offset - output.offset) < SETTLED_MS;
        output.agreed = agrees ? output.agreed + 1 : 0;
        output.offset = offset;
        output.at = performanceTime;
        output.newer++;
      }

      const running = context.state === "running";
      const agreed = output.agreed >= SETTLED_COUNT || output.newer >= SETTLED_LIMIT;
      const settled = output.settled;
      output.settled = running && (output.settled || agreed);
      if (output.settled !== settled) changed();

      // A timestamp from before a pause says nothing of the one after it.
      if (!running) {
        output.agreed = 0;
        output.newer = 0;
      }

      clock.publishOutput(contextTime, performance.timeOrigin + performanceTime, output.settled);
    }

    function everyFrame() {
      publish();
      frame.id = requestAnimationFrame(everyFrame);
    }

    async function watch() {
      try {
        await demuxed;
        demux.done = true;
        changed();
      } catch (e) {
        if (state.current === id) fail(e instanceof Error ? e : new Error(String(e)));
      }
    }

    // Stops both rings' producer, so the media worker is free for the next request.
    function stopPlayback() {
      cancelAnimationFrame(frame.id);
      render.postMessage({ type: "stop" } satisfies ToRender);
      clock.close();
      closeRing(ring);
      node.disconnect();
    }

    // Whether it may start, once and for good: video is decoded and audio buffered ahead, or
    // the render worker says video can get no further while the context is held, as for
    // sparse video or a short audio track. A full PCM ring is audio ahead.
    const prerolled = { done: false };

    function primed() {
      const reported = state.video.id === id ? state.video : undefined;
      const videoAhead = !params || reported?.ahead === true;
      const audioAhead = demux.buffered || demux.done;
      prerolled.done ||= (videoAhead && audioAhead) || reported?.stuck === true;
      return prerolled.done;
    }

    // Whether it is heard, by a settled timestamp, and the frame on screen went up by it.
    function heard() {
      const shown = !params || (state.video.id === id && state.video.shown);
      return output.settled && shown;
    }

    everyFrame();
    void watch();

    return { id, clock, publish, primed, heard, stop: stopPlayback };
  }

  async function stopStarted(playback: Promise<Playback>) {
    try {
      const started = await playback;
      started.stop();
    } catch {
      // It never started; play already rejected with why.
    }
  }

  function stop() {
    if (state.playback) void stopStarted(state.playback);
    state.playback = undefined;
    state.started = undefined;
    state.current = -1;
    changed();
  }

  async function open(file: File) {
    stop();
    state.failure = undefined;
    state.opened = undefined;
    const reply = await media.send({ type: "open", file });
    if (reply.type !== "opened") throw new Error(`open: unexpected ${reply.type}`);
    state.opened = { info: reply.info, video: reply.video };
    return reply.info;
  }

  async function play() {
    if (state.failure) throw state.failure;
    state.playing = true;
    const context = (state.context ??= new AudioContext({ latencyHint: "playback" }));

    if (!state.playback) {
      state.current = state.next++;
      state.playback = startPlayback(context, state.current);
    }

    const playback = state.playback;
    const started = await startedOrCleared(playback);
    // Unless an open stopped it while it started.
    if (state.playback === playback) state.started = started;
    const stopped = () => state.current !== started.id;

    // Rejects if an open or a failure stopped it while it waited.
    const check = () => {
      if (stopped()) throw state.failure ?? new DOMException("play: stopped", "AbortError");
    };

    await until(() => stopped() || !state.playing || (started.primed() && visible()));
    check();
    // Unless a pause came while it started.
    if (!state.playing) return;
    await context.resume();
    await until(() => stopped() || !state.playing || started.heard());
    check();
  }

  // `playback` once it has started; if it fails to, it is no longer what plays.
  async function startedOrCleared(playback: Promise<Playback>) {
    try {
      return await playback;
    } catch (e) {
      if (state.playback === playback) state.playback = undefined;
      throw e;
    }
  }

  async function pause() {
    if (state.failure) throw state.failure;
    state.playing = false;
    changed();
    await state.context?.suspend();
    // Published now, not on the next animation frame, so the clock holds once pause resolves,
    // in a hidden page too.
    state.started?.publish();
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
    document.removeEventListener("visibilitychange", changed);
    stop();
    void state.context?.close();
    render.terminate();
    media.close();
  }

  return {
    open,
    play,
    pause,
    get currentTime() {
      return state.started?.clock.heard(performance.timeOrigin + performance.now()) ?? 0;
    },
    close,
  };
}
