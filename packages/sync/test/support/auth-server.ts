// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The auth server for the relay tests (test/support/relay.ts): src/relay-auth.ts's handler,
// served by Bun in a container that shares the relay's network, since moq-relay asks a plain
// `http://` auth server only on a loopback address.

import { authServer } from "../../src/relay-auth";

Bun.serve({ hostname: "127.0.0.1", port: 4440, fetch: authServer });
console.log("auth server listening");
