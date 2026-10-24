// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// The unit tests (test/*.unit.ts), each file in a Chromium page (tooling/run-unit.ts).
// Usage: bun run test

import { runUnitTests } from "../../../tooling/run-unit";

await runUnitTests(new URL("../", import.meta.url));
