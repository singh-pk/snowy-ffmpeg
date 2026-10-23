// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The WebGPU compositor. A decoded VideoFrame is uploaded into textures of its own, a picture,
// and closed; a picture is drawn into the canvas, rotated and flipped as the stream's display
// matrix says, scaled to fit and centred, with black around it. A frame whose planes can be
// read is converted to RGB here, with its own matrix and range, so every decoder's frames look
// the same and keep every bit; one whose planes cannot (a 10-bit hardware frame) is converted
// by Chromium, as an external texture (docs/architecture.md#colour).

const VERTEX = /* wgsl */ `
struct View {
  // From the canvas's clip space to the picture's texture coordinates.
  map: mat2x2f,
  offset: vec2f,
}

struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) clip: vec2f,
}

// One triangle that covers the target.
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let clip = vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0);
  return Vertex(vec4f(clip, 0.0, 1.0), clip);
}

const BLACK = vec4f(0.0, 0.0, 0.0, 1.0);

fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}
`;

// Y′CbCr planes, read exactly as integers and filtered here: 16-bit textures cannot be
// filtered, or even made, without an optional feature.
const YUV_SHADER = /* wgsl */ `${VERTEX}
struct Colour {
  // From the planes' integer values (Y, Cb, Cr, 1) to R′G′B′.
  yuv: mat4x4f,
  // Whether Cb and Cr share one plane (NV12), as its red and green.
  interleaved: u32,
}

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var luma: texture_2d<u32>;
@group(0) @binding(2) var cb: texture_2d<u32>;
@group(0) @binding(3) var cr: texture_2d<u32>;
@group(0) @binding(4) var<uniform> colour: Colour;

// Plane \`t\` at \`uv\`, filtered bilinearly between its four nearest samples.
fn bilinear(t: texture_2d<u32>, uv: vec2f) -> vec2f {
  let size = vec2i(textureDimensions(t));
  let pos = uv * vec2f(size) - 0.5;
  let base = floor(pos);
  let f = pos - base;
  let lo = clamp(vec2i(base), vec2i(0), size - 1);
  let hi = clamp(vec2i(base) + 1, vec2i(0), size - 1);
  let a = vec2f(textureLoad(t, lo, 0).rg);
  let b = vec2f(textureLoad(t, vec2i(hi.x, lo.y), 0).rg);
  let c = vec2f(textureLoad(t, vec2i(lo.x, hi.y), 0).rg);
  let d = vec2f(textureLoad(t, hi, 0).rg);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = view.map * clip + view.offset;
  let y = bilinear(luma, uv).r;
  let blue = bilinear(cb, uv);
  let red = select(bilinear(cr, uv).r, blue.g, colour.interleaved == 1u);
  let rgb = (colour.yuv * vec4f(y, blue.r, red, 1.0)).rgb;
  return select(BLACK, vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0), inside(uv));
}
`;

// A picture already in RGB: an RGB frame, or one Chromium converted.
const RGB_SHADER = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var picture: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = view.map * clip + view.offset;
  let color = textureSampleLevel(picture, linear, uv, 0.0);
  return select(BLACK, vec4f(color.rgb, 1.0), inside(uv));
}
`;

// A frame whose planes cannot be read, converted by Chromium into a picture of its size.
const IMPORT_SHADER = /* wgsl */ `${VERTEX}
@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var linear: sampler;

@fragment fn fs(@location(0) clip: vec2f) -> @location(0) vec4f {
  let uv = clip * vec2f(0.5, -0.5) + 0.5;
  return vec4f(textureSampleBaseClampToEdge(frame, linear, uv).rgb, 1.0);
}
`;

// What a picture converted by Chromium is stored as: 10 bits a channel, 4 bytes a pixel.
const IMPORTED: GPUTextureFormat = "rgb10a2unorm";

// FFmpeg's identity display matrix: 16.16 fixed point, and 2.30 in the last column.
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];

// Kr and Kb of each matrix (ITU-T H.273); the others are RGB or unknown.
const LUMA: Record<string, [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
  "bt2020-ncl": [0.2627, 0.0593],
};

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

/**
 * Writes into `out` the column-major 4×4 matrix that takes a pixel's `depth`-bit plane values
 * (Y, Cb, Cr, 1) to R′G′B′, by the colour space `space` states. A stream that states no
 * matrix is BT.601, and one that states no range limited, as FFmpeg takes them. For RGB
 * (the planes G, B, R), the planes are R′G′B′ already, scaled by the range: full unless it
 * states limited.
 */
export function yuvMatrix(out: Float32Array, space: VideoColorSpaceInit, depth: number) {
  const max = 2 ** depth - 1;
  const scale = 2 ** (depth - 8);
  // y′ = ys Y + yo, and c′ = cs C + co, from -0.5 to 0.5.
  const [ys, yo, cs, co] = space.fullRange
    ? [1 / max, 0, 1 / max, -(2 ** (depth - 1)) / max]
    : [1 / (219 * scale), -16 / 219, 1 / (224 * scale), -128 / 224];
  out.fill(0);
  out[15] = 1;

  if (space.matrix === "rgb") {
    // RGB is full range unless it states otherwise, as FFmpeg takes it.
    const [s, o] = space.fullRange === false ? [ys, yo] : [1 / max, 0];
    out.set([0, s, 0], 0);
    out.set([0, 0, s], 4);
    out.set([s, 0, 0], 8);
    out.set([o, o, o], 12);
    return;
  }

  const [kr, kb] = LUMA[space.matrix ?? "bt470bg"] ?? [0.299, 0.114];
  const kg = 1 - kr - kb;
  // R = y′ + vr c′r, G = y′ - ub c′b - vr2 c′r, B = y′ + ub2 c′b.
  const vr = 2 * (1 - kr);
  const ub2 = 2 * (1 - kb);
  const ug = (ub2 * kb) / kg;
  const vg = (vr * kr) / kg;
  out.set([ys, ys, ys], 0);
  out.set([0, -ug * cs, ub2 * cs], 4);
  out.set([vr * cs, -vg * cs, 0], 8);
  out.set([yo + vr * co, yo - (ug + vg) * co, yo + ub2 * co], 12);
}

// How a frame of `format` is uploaded: the texture format and size of each plane used, its
// bit depth, and whether it is Y′CbCr. An alpha plane is left out: the canvas is opaque.
function planesOf(
  format: VideoPixelFormat,
  width: number,
  height: number,
): { yuv: boolean; depth: number; planes: [GPUTextureFormat, number, number][] } {
  const half = [(width + 1) >> 1, (height + 1) >> 1] as const;

  if (format === "NV12") {
    return {
      yuv: true,
      depth: 8,
      planes: [
        ["r8uint", width, height],
        ["rg8uint", ...half],
      ],
    };
  }

  if (format === "RGBA" || format === "RGBX") {
    return { yuv: false, depth: 8, planes: [["rgba8unorm", width, height]] };
  }

  if (format === "BGRA" || format === "BGRX") {
    return { yuv: false, depth: 8, planes: [["bgra8unorm", width, height]] };
  }

  const depth = format.includes("P12") ? 12 : format.includes("P10") ? 10 : 8;
  const sample = depth > 8 ? "r16uint" : "r8uint";
  const [cw, ch] = format.startsWith("I420")
    ? half
    : format.startsWith("I422")
      ? [half[0], height]
      : [width, height];
  return {
    yuv: true,
    depth,
    planes: [
      [sample, width, height],
      [sample, cw, ch],
      [sample, cw, ch],
    ],
  };
}

/** A frame uploaded to the GPU, which the compositor draws. */
export interface Picture {
  /** The presentation time, in microseconds. */
  timestamp: number;
  /** Its size as shown, before rotation. */
  displayWidth: number;
  displayHeight: number;
  readonly yuv: boolean;
  readonly bindGroup: GPUBindGroup;
  /** Gives its textures back, for the next frame of its size and format. */
  close(): void;
}

interface Slot extends Picture {
  readonly key: string;
  readonly textures: GPUTexture[];
  readonly colour: GPUBuffer | undefined;
  // The view of a picture Chromium converts into, made once.
  readonly imported: GPUTextureView | undefined;
  // Where each plane is written, made once.
  readonly destinations: { texture: GPUTexture }[];
}

// The size of the part of `frame` that is shown.
const visibleWidth = (frame: VideoFrame) => frame.visibleRect?.width ?? frame.codedWidth;
const visibleHeight = (frame: VideoFrame) => frame.visibleRect?.height ?? frame.codedHeight;

/** A compositor drawing with `device` into `context`, configured for it with `format`. */
export function createCompositor(
  device: GPUDevice,
  context: GPUCanvasContext,
  format: GPUTextureFormat,
) {
  const pipeline = (code: string, output: GPUTextureFormat) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: output }] },
      primitive: { topology: "triangle-list" },
    });
  };

  const yuvPipeline = pipeline(YUV_SHADER, format);
  const rgbPipeline = pipeline(RGB_SHADER, format);
  const importPipeline = pipeline(IMPORT_SHADER, IMPORTED);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  // mat2x2f, then vec2f, padded to 32 bytes.
  const view = new Float32Array(8);
  const viewBuffer = device.createBuffer({
    size: view.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // mat4x4f, then u32, padded to 80 bytes.
  const colour = new Float32Array(20);
  const colourWords = new Uint32Array(colour.buffer);
  // Where a frame's planes are copied on their way to the GPU, grown as frames need.
  const staging = { buffer: new ArrayBuffer(0) };
  // Pictures closed, by size and format, for the next frames; and the last upload, which the
  // next waits for, as they share `staging`.
  const free = new Map<string, Slot[]>();
  const uploads = { last: Promise.resolve() };
  // The kind and size of the frames uploaded last, and what follows from them, worked out
  // again only when they change, so a frame allocates none of it.
  const shape = {
    kind: "",
    width: 0,
    height: 0,
    key: "",
    planes: undefined as ReturnType<typeof planesOf> | undefined,
  };
  // What `colour` was last worked out for, so it is worked out again only when that changes.
  const converted = { space: undefined as VideoColorSpaceInit | undefined, depth: 0, pixels: "" };
  // Where a plane is read from in `staging`, filled in for each.
  const source = { offset: 0, bytesPerRow: 0 };

  function keyOf(kind: string, width: number, height: number) {
    if (kind === shape.kind && width === shape.width && height === shape.height) return shape.key;
    Object.assign(shape, {
      kind,
      width,
      height,
      key: `${kind}:${width}x${height}`,
      planes: undefined,
    });
    return shape.key;
  }

  // A picture of `key` from those closed, or `make`'s. Those of another key are destroyed:
  // a stream's frames keep one size and format, so they are of a stream before.
  function acquire(key: string, make: () => Slot) {
    for (const [other, slots] of free) {
      if (other === key) continue;

      for (const slot of slots) {
        for (const texture of slot.textures) texture.destroy();
        slot.colour?.destroy();
      }

      free.delete(other);
    }

    return free.get(key)?.pop() ?? make();
  }

  function makeSlot(
    key: string,
    textures: GPUTexture[],
    bindGroup: GPUBindGroup,
    colourBuffer?: GPUBuffer,
    imported?: GPUTextureView,
  ): Slot {
    const picture: Slot = {
      key,
      textures,
      destinations: textures.map((t) => ({ texture: t })),
      colour: colourBuffer,
      imported,
      bindGroup,
      yuv: colourBuffer !== undefined,
      timestamp: 0,
      displayWidth: 0,
      displayHeight: 0,
      close() {
        const slots = free.get(key);
        if (slots) slots.push(picture);
        else free.set(key, [picture]);
      },
    };
    return picture;
  }

  const texture = (fmt: GPUTextureFormat, width: number, height: number, usage: number) =>
    device.createTexture({ format: fmt, size: [width, height], usage });

  // Copies the planes of `frame`, which has a format, into a picture, and converts them when
  // drawn.
  async function uploadPlanes(
    frame: VideoFrame,
    pixels: VideoPixelFormat,
    stated: VideoColorSpaceInit,
  ) {
    const width = visibleWidth(frame);
    const height = visibleHeight(frame);
    const size = frame.allocationSize();
    if (size > staging.buffer.byteLength) staging.buffer = new ArrayBuffer(size);
    const layout = await frame.copyTo(staging.buffer);
    const key = keyOf(pixels, width, height);
    shape.planes ??= planesOf(pixels, width, height);
    const { yuv, depth, planes } = shape.planes;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;

    const picture = acquire(key, () => {
      const textures = planes.map(([fmt, w, h]) => texture(fmt, w, h, usage));
      const views = textures.map((t) => t.createView());
      const y = views[0];
      if (!y) throw new Error(`${pixels}: no planes`);
      // NV12 has Cb and Cr in one plane.
      const u = views[1] ?? y;
      const v = views[2] ?? u;

      if (!yuv) {
        const bindGroup = device.createBindGroup({
          layout: rgbPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: viewBuffer } },
            { binding: 1, resource: y },
            { binding: 2, resource: sampler },
          ],
        });
        return makeSlot(key, textures, bindGroup);
      }

      const colourBuffer = device.createBuffer({
        size: colour.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: yuvPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: viewBuffer } },
          { binding: 1, resource: y },
          { binding: 2, resource: u },
          { binding: 3, resource: v },
          { binding: 4, resource: { buffer: colourBuffer } },
        ],
      });
      return makeSlot(key, textures, bindGroup, colourBuffer);
    });

    // Indexed: an iterator would allocate on every frame.
    for (let i = 0; i < picture.destinations.length; i++) {
      const plane = layout[i];
      const destination = picture.destinations[i];
      if (!plane || !destination) throw new Error(`${pixels}: no plane ${i}`);
      source.offset = plane.offset;
      source.bytesPerRow = plane.stride;
      device.queue.writeTexture(destination, staging.buffer, source, destination.texture);
    }

    if (picture.colour) {
      if (stated !== converted.space || depth !== converted.depth || pixels !== converted.pixels) {
        yuvMatrix(colour, stated, depth);
        colourWords[16] = pixels === "NV12" ? 1 : 0;
        Object.assign(converted, { space: stated, depth, pixels });
      }

      device.queue.writeBuffer(picture.colour, 0, colour);
    }

    return picture;
  }

  // Converts `frame`, whose planes cannot be read, into a picture with Chromium's conversion.
  function uploadImported(frame: VideoFrame) {
    const width = visibleWidth(frame);
    const height = visibleHeight(frame);
    const key = keyOf(IMPORTED, width, height);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;

    const picture = acquire(key, () => {
      const picked = texture(IMPORTED, width, height, usage);
      const imported = picked.createView();
      const bindGroup = device.createBindGroup({
        layout: rgbPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: viewBuffer } },
          { binding: 1, resource: imported },
          { binding: 2, resource: sampler },
        ],
      });
      return makeSlot(key, [picked], bindGroup, undefined, imported);
    });

    const into = picture.imported;
    if (!into) throw new Error("no picture texture");
    // An external texture lasts one task, so it needs a bind group of its own.
    const bindGroup = device.createBindGroup({
      layout: importPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: device.importExternalTexture({ source: frame }) },
        { binding: 1, resource: sampler },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: into, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(importPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return picture;
  }

  /**
   * Uploads `frame`, which it takes and closes, into a picture, converting it by the colour its
   * stream states (`stated`): a decoder fills in what the stream leaves out its own way.
   * Uploads complete in the order they are called.
   */
  async function upload(frame: VideoFrame, stated: VideoColorSpaceInit): Promise<Picture> {
    const before = uploads.last;
    const done = Promise.withResolvers<void>();
    uploads.last = done.promise;

    try {
      await before;
      const pixels = frame.format;
      const uploading = pixels ? uploadPlanes(frame, pixels, stated) : uploadImported(frame);
      const picture = await uploading;
      picture.timestamp = frame.timestamp;
      picture.displayWidth = frame.displayWidth;
      picture.displayHeight = frame.displayHeight;
      return picture;
    } finally {
      frame.close();
      done.resolve();
    }
  }

  // The canvas's next texture, cleared to black: around a frame, or with no frame at all.
  function target(): GPURenderPassColorAttachment {
    return {
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: [0, 0, 0, 1],
      storeOp: "store",
    };
  }

  /** Draws `picture`, transformed by display matrix `matrix`. The caller still owns it. */
  function draw(picture: Picture, matrix: readonly number[]) {
    const { width, height } = context.canvas;
    viewMap(view, matrix, picture.displayWidth, picture.displayHeight, width, height);
    device.queue.writeBuffer(viewBuffer, 0, view);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [target()] });
    pass.setPipeline(picture.yuv ? yuvPipeline : rgbPipeline);
    pass.setBindGroup(0, picture.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Clears the canvas to black. */
  function clear() {
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [target()] }).end();
    device.queue.submit([encoder.finish()]);
  }

  return { upload, draw, clear };
}
