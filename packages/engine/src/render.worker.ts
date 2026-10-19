// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render worker. It checks the part of the platform baseline only a worker can see:
// WebGPU on an OffscreenCanvas, WebCodecs, and a VideoFrame imported as a GPU texture, the
// path every WebCodecs frame takes to the screen.

import type { FromRender, Missing, ToRender } from "./protocol";

function post(message: FromRender) {
  self.postMessage(message);
}

// A device drawing into `canvas`, or what is missing for one.
async function openGPU(canvas: OffscreenCanvas): Promise<GPUDevice | Missing> {
  if (!("gpu" in navigator)) return ["webgpu", "navigator.gpu is missing"];

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return ["webgpu", "no GPU adapter"];
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");

    if (!(context instanceof GPUCanvasContext)) {
      return ["webgpu", "no WebGPU context for an OffscreenCanvas in a worker"];
    }

    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
    return device;
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

async function check(canvas: OffscreenCanvas): Promise<Missing | undefined> {
  const device = await openGPU(canvas);
  if (Array.isArray(device)) return device;
  const frame = createFrame();
  if (Array.isArray(frame)) return frame;

  try {
    device.importExternalTexture({ source: frame });
    return undefined;
  } catch (e) {
    return ["webgpu-external-texture", String(e)];
  } finally {
    frame.close();
  }
}

async function init(canvas: OffscreenCanvas) {
  const missing = await check(canvas);
  post(missing ? { type: "unsupported", missing } : { type: "ready" });
}

self.addEventListener("message", ({ data }: MessageEvent<ToRender>) => {
  if (data.type === "init") void init(data.canvas);
});
