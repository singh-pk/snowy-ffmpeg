// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Serves a package to a browser for its tests and benchmarks, with the cross-origin isolation
// (COOP + COEP) that SharedArrayBuffer and WebAssembly threads need, unless `isolated` is
// false (to test a page without it).

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// `page` is the HTML served at "/"; every other path is a file under `root`.
export function serve(root: URL, page: string, { isolated = true } = {}) {
  const headers = isolated ? ISOLATION : {};

  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;

      if (path === "/") {
        return new Response(page, { headers: { ...headers, "Content-Type": "text/html" } });
      }

      const file = Bun.file(root.pathname + path.slice(1));
      const exists = await file.exists();
      return exists ? new Response(file, { headers }) : new Response("not found", { status: 404 });
    },
  });
}
