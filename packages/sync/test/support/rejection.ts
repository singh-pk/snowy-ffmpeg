// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// What a promise rejects with, or undefined if it resolves: awaited as a value, so a test
// asserts on it and can't forget to wait for the rejection.

export async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e;
  }

  return undefined;
}
