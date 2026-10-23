// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The module worker tooling/run-unit.ts starts for each unit test file, the file's bundle in
// its URL (`?file=`). It imports the file, which settles only once the file has loaded,
// top-level awaits and all, so every test is registered; then runs them in order and posts the
// failures. An error or rejection no test awaited, while a test runs, fails that test.

import { registry } from "./unit";

/** What the worker posts once its tests have run. */
export interface Ran {
  ran: number;
  failed: string[];
}

const show = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
// The test running, and what escaped it.
const current = { name: "loading the file", escaped: [] as string[] };

// Handled here, so a test's stray error fails that test, not the whole file.
addEventListener("error", (e) => {
  e.preventDefault();
  current.escaped.push(e instanceof ErrorEvent ? show(e.error ?? e.message) : e.type);
});

addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  current.escaped.push(e instanceof PromiseRejectionEvent ? show(e.reason) : e.type);
});

// One task, on a message rather than a timer.
async function turn() {
  const channel = new MessageChannel();
  const next = Promise.withResolvers<void>();
  channel.port1.addEventListener("message", () => next.resolve(), { once: true });
  channel.port1.start();
  channel.port2.postMessage(null);
  await next.promise;
  channel.port1.close();
}

// Chromium reports an unhandled rejection in a task of its own, after the one that made it:
// two tasks on, a test's strays have come.
async function settle() {
  await turn();
  await turn();
}

async function run() {
  const failed: string[] = [];
  const file = new URL(location.href).searchParams.get("file") ?? "";

  try {
    await import(file);
  } catch (e) {
    failed.push(`loading ${file}: ${show(e)}`);
  }

  for (const { name, body } of registry) {
    current.name = name;
    current.escaped = [];

    try {
      await body();
    } catch (e) {
      failed.push(`${name}: ${show(e)}`);
    }

    await settle();
    for (const e of current.escaped) failed.push(`${name}: escaped: ${e}`);
  }

  postMessage({ ran: registry.length, failed } satisfies Ran);
}

void run();
