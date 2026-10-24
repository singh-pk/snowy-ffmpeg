// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The render worker's decoders for the video streams WebCodecs does not decode: each stands in
// for a VideoDecoder in src/video.ts, and decodes in the video decode worker
// (src/video.worker.ts), which this starts once and keeps, so a seek or another file does not
// load its FFmpeg module again.

import type { VideoParams } from "./codec";
import type { FromVideo, HeldFrame, ToVideo } from "./protocol";
import type { Packet } from "./ring";

type Module = "video" | "video-ext";

/**
 * A frame FFmpeg decoded, its planes still in `memory`, the decoding module's, where `layout`
 * says: uploaded from there, it is never copied on the CPU. Closing it hands it back.
 */
export interface SharedFrame extends Omit<HeldFrame, "frame" | "packed" | "size"> {
  readonly displayHeight: number;
  readonly memory: WebAssembly.Memory;
  allocationSize(): number;
  close(): void;
}

/** A decoded frame: from WebCodecs, or from FFmpeg. */
export type DecodedFrame = VideoFrame | SharedFrame;

/** Where a decoder's frames, its taking a packet, and its failure go. */
export interface DecoderEvents {
  output: (frame: DecodedFrame) => void;
  dequeue: () => void;
  error: (e: Error) => void;
}

/** A video decoder, as src/video.ts uses one. */
export interface Decoder {
  /**
   * Decodes `packet`, whose frame is due at `pts`, in the stream's time base: at `timestamp`,
   * for `duration`, in microseconds. `pts` is the packet's, or its dts where it has none.
   */
  decode(packet: Packet, pts: bigint, timestamp: number, duration: number): void;
  /** Resolves once every packet is decoded and its frames are out. */
  flush(): Promise<void>;
  /** Packets handed over and not yet decoded. */
  queued(): number;
  close(): void;
}

interface Open {
  events: DecoderEvents;
  memory?: WebAssembly.Memory;
  queued: number;
  flushed: PromiseWithResolvers<void>;
}

/**
 * The decoders, in the worker `start` starts: the bundled src/video.worker.ts next to this
 * file, written out as is so that a bundler finds the worker.
 */
export function createWasmVideo(
  start = () => new Worker(new URL("./video.worker.js", import.meta.url), { type: "module" }),
) {
  const state = {
    worker: undefined as Worker | undefined,
    next: 0,
    failed: undefined as Error | undefined,
  };
  const open = new Map<number, Open>();

  // `held`, from `module`, whose memory is `memory`, as a frame that goes back to it once closed.
  function shared(held: HeldFrame, module: Module, memory: WebAssembly.Memory): SharedFrame {
    const { frame, packed, size, ...rest } = held;
    const own = { closed: false };

    return {
      ...rest,
      displayHeight: held.codedHeight,
      memory,
      allocationSize: () => size,
      close() {
        if (own.closed) return;
        own.closed = true;
        send({ type: "release", module, frame, packed });
      },
    };
  }

  function receive({ data }: MessageEvent<FromVideo>) {
    const decoder = open.get(data.id);

    if (data.type === "frame") {
      const { module, frame } = data;
      const memory = decoder?.memory;
      // A decoder closed since: nothing takes it, so it goes back at once.
      if (decoder && memory) decoder.events.output(shared(frame, module, memory));
      else send({ type: "release", module, frame: frame.frame, packed: frame.packed });
    } else if (!decoder) {
      return;
    } else if (data.type === "memory") {
      decoder.memory = data.memory;
    } else if (data.type === "error") {
      decoder.events.error(new Error(data.message));
    } else if (data.flushed) {
      decoder.flushed.resolve();
    } else {
      decoder.queued--;
      decoder.events.dequeue();
    }
  }

  // The worker, started on first use. Its failure fails every decoder, and every one after.
  function worker() {
    if (state.worker) return state.worker;
    const started = start();
    started.addEventListener("message", receive);

    started.addEventListener("error", (e) => {
      state.failed = new Error(`video decode worker: ${e.message}`);
      for (const decoder of open.values()) decoder.events.error(state.failed);
    });

    state.worker = started;
    return started;
  }

  const send = (message: ToVideo, transfer: Transferable[] = []) =>
    worker().postMessage(message, transfer);

  /** A decoder of the stream with parameters `p`, which an FFmpeg module decodes. */
  function createDecoder(p: VideoParams, events: DecoderEvents): Decoder {
    const module = p.decoder === "video" || p.decoder === "video-ext" ? p.decoder : undefined;

    // No module decodes it, or the worker has failed: it fails at its first packet.
    const failure = module ? state.failed : new Error(`${p.codec}: no decoder for this codec`);

    if (!module || failure) {
      return {
        decode() {
          throw failure;
        },
        flush: async () => {},
        queued: () => 0,
        close() {},
      };
    }

    const id = state.next++;
    const flushed = Promise.withResolvers<void>();
    const decoder: Open = { events, queued: 0, flushed };
    open.set(id, decoder);
    send({ type: "open", id, module, params: p.params, timeBase: p.timeBase });

    return {
      decode(packet, pts) {
        // A copy: the packet's data is the packet ring's, which frees it at once.
        const data = packet.data.slice();
        const { dts, duration, flags } = packet;
        decoder.queued++;
        send({ type: "decode", id, data, pts, dts, duration, flags }, [data.buffer]);
      },
      flush() {
        send({ type: "flush", id });
        return decoder.flushed.promise;
      },
      queued: () => decoder.queued,
      // A flush under way ends, as VideoDecoder.close() ends one.
      close() {
        if (!open.delete(id)) return;
        decoder.flushed.reject(new DOMException("closed", "AbortError"));
        send({ type: "close", id });
      },
    };
  }

  return { createDecoder };
}
