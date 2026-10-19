// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The public API of @snowy-media/engine.

import { checkMainThread, UnsupportedPlatformError } from "./platform";
import type { FromRender, ToRender } from "./protocol";

export { UnsupportedPlatformError } from "./platform";
export type { PlatformFeature } from "./protocol";

export interface EngineOptions {
  /** The canvas the engine draws video into; the engine takes control of it. */
  canvas: HTMLCanvasElement;
}

export interface Engine {
  /** Stops the engine's workers. */
  close(): void;
}

// Sends `message` to `worker` and resolves with its reply, or rejects if the worker fails to load.
function request(worker: Worker, message: ToRender, transfer: Transferable[]) {
  return new Promise<FromRender>((resolve, reject) => {
    worker.addEventListener("message", (e: MessageEvent<FromRender>) => resolve(e.data), {
      once: true,
    });
    // A worker that fails to load fires a plain Event, without a message.
    worker.addEventListener(
      "error",
      (e) =>
        reject(new Error(e instanceof ErrorEvent ? e.message : "the render worker failed to load")),
      { once: true },
    );
    worker.postMessage(message, transfer);
  });
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

  try {
    const reply = await request(render, { type: "init", canvas: offscreen }, [offscreen]);
    if (reply.type === "unsupported") throw new UnsupportedPlatformError(reply.missing);
  } catch (e) {
    render.terminate();
    throw e;
  }

  return { close: () => render.terminate() };
}
