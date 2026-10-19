// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render worker. It checks the part of the platform baseline only a worker can see:
// WebGPU on an OffscreenCanvas, WebCodecs, and a VideoFrame imported as a GPU texture, the
// path every WebCodecs frame takes to the screen. Then it plays video: on each animation
// frame it shows the frame due when that animation frame reaches the screen, by the audio
// clock (src/pcm.ts).

import { createCompositor } from "./compositor";
import { createPcmControl } from "./pcm";
import type { FromRender, Missing, ToRender } from "./protocol";
import { createVideoOutput } from "./video";

interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

// An animation frame's length until two have been timed, and the longest one counted: a
// longer gap is a stall, not the display's rate. The refresh is the shortest of the last
// GAPS gaps, so one late animation frame does not move the next frame's target.
const REFRESH = 1000 / 60;
const LONGEST_REFRESH = 50;
const GAPS = 8;

const state = {
  compositor: undefined as ReturnType<typeof createCompositor> | undefined,
  // What plays, and its animation frame request.
  playing: undefined as { output: ReturnType<typeof createVideoOutput>; frame: number } | undefined,
};

function post(message: FromRender) {
  self.postMessage(message);
}

// A device drawing into `canvas`, or what is missing for one.
async function openGPU(canvas: OffscreenCanvas): Promise<Gpu | Missing> {
  if (!("gpu" in navigator)) return ["webgpu", "navigator.gpu is missing"];

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return ["webgpu", "no GPU adapter"];
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");

    if (!(context instanceof GPUCanvasContext)) {
      return ["webgpu", "no WebGPU context for an OffscreenCanvas in a worker"];
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    return { device, context, format };
  } catch (e) {
    return ["webgpu", String(e)];
  }
}

// A 2×2 VideoFrame, or what is missing for one.
function createFrame(): VideoFrame | Missing {
  if (typeof VideoDecoder === "undefined") return ["webcodecs", "VideoDecoder is missing"];

  try {
    const options = { format: "RGBA", codedWidth: 2, codedHeight: 2, timestamp: 0 } as const;
    return new VideoFrame(new Uint8Array(16), options);
  } catch (e) {
    return ["webcodecs", String(e)];
  }
}

async function check(canvas: OffscreenCanvas): Promise<Gpu | Missing> {
  const gpu = await openGPU(canvas);
  if (Array.isArray(gpu)) return gpu;
  const frame = createFrame();
  if (Array.isArray(frame)) return frame;

  try {
    gpu.device.importExternalTexture({ source: frame });
    return gpu;
  } catch (e) {
    return ["webgpu-external-texture", String(e)];
  } finally {
    frame.close();
  }
}

async function init(canvas: OffscreenCanvas) {
  const gpu = await check(canvas);

  if (Array.isArray(gpu)) {
    post({ type: "unsupported", missing: gpu });
    return;
  }

  state.compositor = createCompositor(gpu.device, gpu.context, gpu.format);
  post({ type: "ready" });
}

function stop() {
  if (!state.playing) return;
  self.cancelAnimationFrame(state.playing.frame);
  state.playing.output.close();
  state.playing = undefined;
}

function play({ id, ring, params, pcm }: Extract<ToRender, { type: "play" }>) {
  stop();
  if (!state.compositor) throw new Error("play before init");
  const output = createVideoOutput(ring, params, state.compositor);
  const clock = createPcmControl(pcm);
  const playing = { output, frame: 0 };
  const timing = { last: 0, next: 0, gaps: new Float64Array(GAPS).fill(REFRESH) };

  // Reports the first failure of this play, unless it has stopped.
  function fail(e: unknown) {
    if (state.playing !== playing) return;
    stop();
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }

  // `time` is when this animation frame started; what it draws is seen one refresh later.
  function draw(time: number) {
    const gap = time - timing.last;

    if (timing.last > 0 && gap < LONGEST_REFRESH) {
      timing.gaps[timing.next] = gap;
      timing.next = (timing.next + 1) % GAPS;
    }

    timing.last = time;
    let refresh = LONGEST_REFRESH;
    // Indexed: an iterator would allocate on every animation frame.
    for (let i = 0; i < GAPS; i++) refresh = Math.min(refresh, timing.gaps[i] ?? REFRESH);

    try {
      const seen = clock.heard(performance.timeOrigin + time + refresh);
      output.present(Math.round(seen * 1e6));
    } catch (e) {
      fail(e);
      return;
    }

    playing.frame = self.requestAnimationFrame(draw);
  }

  async function watch() {
    try {
      await output.done;
    } catch (e) {
      fail(e);
    }
  }

  playing.frame = self.requestAnimationFrame(draw);
  state.playing = playing;
  void watch();
}

self.addEventListener("message", ({ data }: MessageEvent<ToRender>) => {
  if (data.type === "init") void init(data.canvas);
  else if (data.type === "play") play(data);
  else stop();
});
