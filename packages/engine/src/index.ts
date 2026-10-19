// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The public API of @snowy-media/engine.

import { checkMainThread, UnsupportedPlatformError } from "./platform";
import type { FromMedia, FromRender, MediaInfo, ToMedia, ToRender } from "./protocol";

export { UnsupportedPlatformError } from "./platform";
export type { MediaInfo, PlatformFeature, Track } from "./protocol";

export interface EngineOptions {
  /** The canvas the engine draws video into; the engine takes control of it. */
  canvas: HTMLCanvasElement;
}

export interface Engine {
  /** Opens `file` in place of the open one, and resolves with what it holds. */
  open(file: File): Promise<MediaInfo>;
  /** Stops the engine's workers. */
  close(): void;
}

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

// The media worker, as a function per request; replies may come in any order.
function createMedia() {
  const worker = new Worker(new URL("./media.worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, PromiseWithResolvers<MediaInfo>>();
  let next = 0;
  // Once set, why every open rejects: the worker failed to load, or the engine closed.
  let failed: Error | undefined;

  worker.addEventListener("message", ({ data }: MessageEvent<FromMedia>) => {
    const call = pending.get(data.id);
    pending.delete(data.id);
    if (data.type === "opened") call?.resolve(data.info);
    else if (data.type === "error") call?.reject(new Error(data.message));
  });

  function fail(error: Error) {
    failed ??= error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  }

  worker.addEventListener("error", (e) => fail(loadError(e, "media")));

  function open(file: File) {
    if (failed) return Promise.reject(failed);
    const call = Promise.withResolvers<MediaInfo>();
    const message: ToMedia = { type: "open", id: next++, file };
    pending.set(message.id, call);
    worker.postMessage(message);
    return call.promise;
  }

  function close() {
    worker.terminate();
    fail(new Error("the engine is closed"));
  }

  return { open, close };
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

  function close() {
    render.terminate();
    media.close();
  }

  try {
    const reply = await request(render, { type: "init", canvas: offscreen }, [offscreen]);
    if (reply.type === "unsupported") throw new UnsupportedPlatformError(reply.missing);
  } catch (e) {
    close();
    throw e;
  }

  return { open: media.open, close };
}
