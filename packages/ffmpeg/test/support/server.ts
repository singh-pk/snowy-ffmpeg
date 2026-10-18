// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Serves the repository to a browser for the tests and the benchmarks, with the
// cross-origin isolation (COOP + COEP) that SharedArrayBuffer and WebAssembly threads need.

const root = new URL("../../", import.meta.url).pathname;

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// `page` is the HTML served at "/"; every other path is a file in the repository.
export function serve(page: string) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;

      if (path === "/") {
        return new Response(page, { headers: { ...headers, "Content-Type": "text/html" } });
      }

      const file = Bun.file(root + path.slice(1));
      const exists = await file.exists();
      return exists ? new Response(file, { headers }) : new Response("not found", { status: 404 });
    },
  });
}
