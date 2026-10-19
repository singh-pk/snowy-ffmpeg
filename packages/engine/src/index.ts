// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The public API of @snowy-media/engine.

import { createAudioOutput } from "./audio";
import type { VideoParams } from "./codec";
import { createPcmControl, createPcmRing } from "./pcm";
import { checkMainThread, UnsupportedPlatformError } from "./platform";
import type { FromMedia, FromRender, MediaInfo, ToMedia, ToRender } from "./protocol";
import { createConsumer, createRing, RING_CAPACITY } from "./ring";

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
   * browser allows audio to start (after a user gesture), unless a pause comes first. Rejects
   * if playing has failed, or with an AbortError if an open stops it while it starts.
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
// What the PCM ring mixes to; the context's destination takes stereo everywhere.
const CHANNELS = 2;

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

// The media worker, as a function per request; replies may come in any order.
function createMedia() {
  const worker = new Worker(new URL("./media.worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, PromiseWithResolvers<FromMedia>>();
  let next = 0;
  // Once set, why every request rejects: the worker failed to load, or the engine closed.
  let failed: Error | undefined;

  worker.addEventListener("message", ({ data }: MessageEvent<FromMedia>) => {
    const call = pending.get(data.id);
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

  function send(message: DistributiveOmit<ToMedia, "id">) {
    if (failed) return Promise.reject(failed);
    const call = Promise.withResolvers<FromMedia>();
    const id = next++;
    pending.set(id, call);
    worker.postMessage({ ...message, id });
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

// The engine on a render worker that is ready and a media worker.
function createPlayer(render: Worker, media: ReturnType<typeof createMedia>): Engine {
  const state = {
    opened: undefined as { info: MediaInfo; video: Record<number, VideoParams> } | undefined,
    // Made on the first play, and kept: a page may only start so many.
    context: undefined as AudioContext | undefined,
    // Set at once, so a second play while the first starts joins it.
    playback: undefined as ReturnType<typeof startPlayback> | undefined,
    // The clock of what plays, once it has started.
    clock: undefined as ReturnType<typeof createPcmControl> | undefined,
    // Why playing stopped, until the next open.
    failure: undefined as Error | undefined,
    // The id of what plays, whose failures count, or -1; and the next one.
    current: -1,
    next: 0,
    // Whether the last call was play, not pause.
    playing: false,
    closed: false,
  };

  render.addEventListener("message", ({ data }: MessageEvent<FromRender>) => {
    if (data.type === "error" && data.id === state.current) fail(new Error(data.message));
  });
  // An uncaught error in the render worker.
  render.addEventListener("error", (e) => fail(loadError(e, "render")));

  function fail(error: Error) {
    state.failure ??= error;
    stop();
  }

  // Starts the open file playing into `context` from its start, as play `id`.
  async function startPlayback(context: AudioContext, id: number) {
    const opened = state.opened;
    if (!opened) throw new Error("play: no file is open");
    const audio = opened.info.tracks.find((t) => t.kind === "audio");
    // Video-only files need a clock without audio; they come later.
    if (!audio) throw new Error("play: a file without audio does not play yet");
    const video = opened.info.tracks.find((t) => t.kind === "video");
    const params = video && opened.video[video.id];
    const pcm = createPcmRing(pcmFrames(context.sampleRate), CHANNELS, context.sampleRate);
    const clock = createPcmControl(pcm);
    const node = await createAudioOutput(context, pcm);

    // An open may have stopped this play while the worklet loaded, and the media worker may
    // hold another file already.
    if (state.current !== id) {
      clock.close();
      node.disconnect();
      throw new DOMException("play: stopped while it started", "AbortError");
    }

    const ring = createRing(params ? RING_CAPACITY : NO_VIDEO_RING);
    if (params) render.postMessage({ type: "play", id, ring, params, pcm } satisfies ToRender);
    const streams = video && params ? [video.id] : [];
    const demuxed = media.send({ type: "demux", ring, streams, audio: { stream: audio.id, pcm } });
    const frame = { id: 0 };

    // The output timestamp, for the render worker (src/pcm.ts), on every animation frame.
    // Until output starts it is zero, which is no time heard yet, so it is not running.
    function publish() {
      const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
      clock.publishOutput(
        contextTime,
        performance.timeOrigin + performanceTime,
        context.state === "running" && performanceTime > 0,
      );
      frame.id = requestAnimationFrame(publish);
    }

    async function watch() {
      try {
        await demuxed;
      } catch (e) {
        if (state.current === id) fail(e instanceof Error ? e : new Error(String(e)));
      }
    }

    // Stops both rings' producer, so the media worker is free for the next request.
    function stopPlayback() {
      cancelAnimationFrame(frame.id);
      render.postMessage({ type: "stop" } satisfies ToRender);
      clock.close();
      createConsumer(ring).close();
      node.disconnect();
    }

    publish();
    void watch();
    return { clock, stop: stopPlayback };
  }

  async function stopStarted(playback: ReturnType<typeof startPlayback>) {
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
    state.clock = undefined;
    state.current = -1;
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

    try {
      const started = await playback;
      // Unless an open stopped it while it started.
      if (state.playback === playback) state.clock = started.clock;
    } catch (e) {
      if (state.playback === playback) state.playback = undefined;
      throw e;
    }

    // Unless a pause came while it started.
    if (state.playing) await context.resume();
  }

  async function pause() {
    if (state.failure) throw state.failure;
    state.playing = false;
    await state.context?.suspend();
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
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
      return state.clock?.heard(performance.timeOrigin + performance.now()) ?? 0;
    },
    close,
  };
}
