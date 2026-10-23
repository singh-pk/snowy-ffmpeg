// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// The packets the ring test's producer writes (test/support/ring-producer.ts): packet i has
// size(i) bytes. Apart from the producer, so the test imports it without the worker's handler.

export const size = (i: number) => (i * 7919) % 3001;
