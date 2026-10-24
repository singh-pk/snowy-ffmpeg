// Temporary: which Chromium flags give WebGPU, a canvas readback and an external texture here.
import { chromium } from "playwright";
const variants = [
  ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--use-gl=angle", "--enable-features=Vulkan", "--use-vulkan=swiftshader"],
  ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader"],
  ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader"],
  ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-gpu"],
  ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-gpu", "--use-webgpu-adapter=d3d11"],
  ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=d3d11-warp"],
  ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"],
];
const server = Bun.serve({ port: 0, fetch: () => new Response("<!doctype html><title>p</title>", { headers: { "content-type": "text/html", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" } }) });
for (const args of variants) {
  const browser = await chromium.launch({ args });
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://localhost:${server.port}/`);
    const r = await tab.evaluate(async () => {
      const step = async (f: () => Promise<unknown>) => { try { return String(await f()); } catch (e) { return "ERR " + String(e).slice(0, 80); } };
      const a = await navigator.gpu?.requestAdapter();
      if (!a) return "no adapter";
      const info = `${a.info.vendor}/${a.info.architecture}/${a.info.description}`;
      const device = await a.requestDevice();
      const canvas = new OffscreenCanvas(4, 4);
      const ctx = canvas.getContext("webgpu")!;
      ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, alphaMode: "opaque" });
      const read = await step(async () => { const b = device.createBuffer({ size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); const e = device.createCommandEncoder(); e.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 1, 0, 1] }] }).end(); e.copyTextureToBuffer({ texture: ctx.getCurrentTexture() }, { buffer: b, bytesPerRow: 256 }, [4, 4]); device.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ); return Array.from(new Uint8Array(b.getMappedRange()).slice(0, 4)).join(","); });
      const ext = await step(async () => { const f = new VideoFrame(new Uint8Array(64), { format: "RGBA", codedWidth: 4, codedHeight: 4, timestamp: 0 }); device.importExternalTexture({ source: f }); f.close(); return "ok"; });
      return `${info} | readback ${read} | external ${ext}`;
    });
    console.log(`PROBE ${args.join(" ")} => ${r}`);
  } catch (e) {
    console.log(`PROBE ${args.join(" ")} => launch/eval ERR ${String(e).slice(0, 120)}`);
  }
  await browser.close();
}
server.stop(true);
