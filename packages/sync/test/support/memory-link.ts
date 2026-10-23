// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Links in memory, for tests: each pair joins two peers as a transport would. A message goes as
// JSON and an object as a copy of its bytes, each arriving in a later task and in order; once a link
// closes, nothing more arrives on it, including what was still on its way. Every arrival is
// tracked, so a test can wait until the network is quiet.

import type { Bytes, KeyId } from "../../src/crypto";
import type { Link, LinkEvents, Message } from "../../src/link";

type Handlers = { [E in keyof LinkEvents]: Array<LinkEvents[E]> };

// One end's peer and the handlers registered on it.
function end(peer: KeyId) {
  const handlers: Handlers = { message: [], object: [], close: [] };
  const on = <E extends keyof LinkEvents>(event: E, handler: LinkEvents[E]) =>
    (handlers[event] as Array<LinkEvents[E]>).push(handler);
  return { peer, handlers, on };
}

export function createNetwork() {
  const arrivals: Array<Promise<unknown>> = [];
  // One channel for every arrival: messages on one port come in the order they were posted, each
  // in a task of its own, as over a transport, with no timer.
  const { port1, port2 } = new MessageChannel();
  const tasks: Array<() => void> = [];
  port2.addEventListener("message", () => tasks.shift()?.());
  port2.start();

  function nextTask() {
    const { promise, resolve } = Promise.withResolvers<void>();
    tasks.push(resolve);
    port1.postMessage(null);
    return promise;
  }

  // Runs `work` in a later task, tracked until it and what it returned end.
  function later(work: () => unknown[]) {
    const arrive = async () => {
      await nextTask();
      await Promise.all(work());
    };

    arrivals.push(arrive());
  }

  /** Two ends of one link: the first held by `a`, reaching `b`, and the second the other way. */
  function pair(a: KeyId, b: KeyId): [Link, Link] {
    const state = { open: true };
    const ends = [end(b), end(a)] as const;

    function link(from: 0 | 1): Link {
      const self = ends[from];
      const other = ends[from === 0 ? 1 : 0];

      function send(message: Message) {
        if (!state.open) return;
        const value: unknown = JSON.parse(JSON.stringify(message));
        later(() => (state.open ? other.handlers.message.map((h) => h(value)) : []));
      }

      function deliver(key: string, bytes: Bytes) {
        if (!state.open) return;
        const copy = bytes.slice();
        later(() => (state.open ? other.handlers.object.map((h) => h(key, copy)) : []));
      }

      function close() {
        if (!state.open) return;
        state.open = false;
        later(() => [...ends[0].handlers.close, ...ends[1].handlers.close].map((h) => h()));
      }

      return { peer: self.peer, send, deliver, on: self.on, close };
    }

    return [link(0), link(1)];
  }

  /** Waits until everything sent, and everything that sent in turn, has arrived. */
  async function settle() {
    while (arrivals.length > 0) await Promise.all(arrivals.splice(0));
  }

  return { pair, settle };
}
