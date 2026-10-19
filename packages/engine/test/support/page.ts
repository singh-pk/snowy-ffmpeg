// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Code for the test and benchmark pages, bundled by serve.ts and imported from PAGE: the
// packet ring, and the hash test/fixtures/expected.json records for a stream's packets.

import { AV_NOPTS_VALUE, AV_PKT_FLAG_KEY } from "@snowy-media/ffmpeg/core";
import type { FromMedia, ToMedia } from "../../src/protocol";
import { createConsumer, END, FAILED } from "../../src/ring";

export { createRing, RING_CAPACITY } from "../../src/ring";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// CRC-32 as zlib and ffprobe's -show_data_hash crc32 compute it.
function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 255] ?? 0) ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const timestamp = (t: bigint) => (t === AV_NOPTS_VALUE ? "" : String(t));

/**
 * Reads `ring` to its END record and resolves with each stream's packet count and the
 * SHA-256 of its lines `pts,dts,key,size,crc32`, without dts unless `dts`
 * (scripts/gen-fixtures.ts); or with "failed" at a FAILED record.
 */
export async function hashRing(ring: SharedArrayBuffer, dts: boolean) {
  const consumer = createConsumer(ring);
  const lines = new Map<number, string[]>();

  for (;;) {
    const packet = consumer.peek();

    if (!packet) {
      await consumer.wait();
      continue;
    }

    if (packet.stream === END) break;
    if (packet.stream === FAILED) return "failed";
    const { stream, flags, data } = packet;
    const key = flags & AV_PKT_FLAG_KEY ? 1 : 0;
    const times = dts ? `${timestamp(packet.pts)},${timestamp(packet.dts)}` : timestamp(packet.pts);
    const line = `${times},${key},${data.length},${crc32(data)}`;
    const all = lines.get(stream);
    if (all) all.push(line);
    else lines.set(stream, [line]);
    consumer.release();
  }

  const hashes: Record<number, { packets: number; packetsSha256: string }> = {};

  for (const [stream, all] of lines) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(all.join("\n")));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"));
    hashes[stream] = { packets: all.length, packetsSha256: hex.join("") };
  }

  return hashes;
}

/** Starts the media worker at `url`, as a function per request; an error reply rejects. */
export function startMedia(url: string) {
  const worker = new Worker(url, { type: "module" });
  let next = 0;

  function request(message: DistributiveOmit<ToMedia, "id">) {
    const id = next++;

    return new Promise<FromMedia>((resolve, reject) => {
      worker.addEventListener("message", function reply(e: MessageEvent<FromMedia>) {
        if (e.data.id !== id) return;
        worker.removeEventListener("message", reply);
        if (e.data.type === "error") reject(new Error(e.data.message));
        else resolve(e.data);
      });
      worker.postMessage({ ...message, id });
    });
  }

  return { request, stop: () => worker.terminate() };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
