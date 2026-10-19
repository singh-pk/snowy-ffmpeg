// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The WebGPU compositor: draws a VideoFrame into the canvas, rotated and flipped as the
// stream's display matrix says, scaled to fit and centred, with black around it. The frame is
// sampled as an external texture, which converts it to the canvas's RGB with its own colour
// space (SDR only, for now).

const SHADER = /* wgsl */ `
struct View {
  // From the canvas's clip space to the frame's texture coordinates.
  map: mat2x2f,
  offset: vec2f,
}

@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var<uniform> view: View;

struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

// One triangle that covers the canvas.
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let clip = vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0);
  return Vertex(vec4f(clip, 0.0, 1.0), clip);
}

@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = view.map * clip + view.offset;
  let color = textureSampleBaseClampToEdge(frame, linear, uv);
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(color.rgb, 1.0), inside);
}
`;

// FFmpeg's identity display matrix: 16.16 fixed point, and 2.30 in the last column.
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];

/**
 * Writes into `out` the map from clip space to texture coordinates (a column-major 2×2, then
 * the offset) that shows a `width` × `height` frame transformed by display matrix `matrix`,
 * fitted into a `canvasWidth` × `canvasHeight` canvas. FFmpeg's matrix takes a point (x, y)
 * of the frame, y down, to (a x + c y, b x + d y) on the display, where a, b, c, d are its
 * entries 0, 1, 3 and 4 (libavutil/display.h).
 */
export function viewMap(
  out: Float32Array,
  matrix: readonly number[],
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const [a = 1, b = 0, , c = 0, d = 1] = matrix;
  const det = a * d - b * c;
  // A matrix that collapses the frame is no transform at all.
  if (det === 0) return viewMap(out, IDENTITY, width, height, canvasWidth, canvasHeight);

  // The display's size, the frame's corners transformed, and the scale that fits it in.
  const displayWidth = Math.abs(a) * width + Math.abs(c) * height;
  const displayHeight = Math.abs(b) * width + Math.abs(d) * height;
  const fit = Math.min(canvasWidth / displayWidth, canvasHeight / displayHeight);
  // Clip space to display pixels from the centre, y down.
  const sx = canvasWidth / (2 * fit);
  const sy = -canvasHeight / (2 * fit);
  // Then by the inverse matrix to frame pixels from the centre, then to texture coordinates.
  out[0] = (d / det / width) * sx;
  out[1] = (-b / det / height) * sx;
  out[2] = (-c / det / width) * sy;
  out[3] = (a / det / height) * sy;
  out[4] = 0.5;
  out[5] = 0.5;
}

/** A compositor drawing with `device` into `context`, configured for it with `format`. */
export function createCompositor(
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) {
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  // mat2x2f, then vec2f, padded to 32 bytes.
  const view = new Float32Array(8);
  const uniform = device.createBuffer({
    size: view.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const layout = pipeline.getBindGroupLayout(0);

  /** Draws `frame`, transformed by display matrix `matrix`. The caller still owns `frame`. */
  function draw(frame: VideoFrame, matrix: readonly number[]) {
    const { width, height } = context.canvas;
    viewMap(view, matrix, frame.displayWidth, frame.displayHeight, width, height);
    device.queue.writeBuffer(uniform, 0, view);
    // An external texture lasts one task, so each frame needs its own bind group.
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: device.importExternalTexture({ source: frame }) },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: [0, 0, 0, 1],
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return { draw };
}
