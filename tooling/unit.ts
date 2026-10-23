// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// `test` and `expect` for a unit test file (`test/**/*.unit.ts`), which runs in Chromium,
// never in Bun: tooling/run-unit.ts bundles the file, and tooling/unit-worker.ts imports it in a
// module worker, which can block (Atomics.wait) as the engine's workers do, and runs the tests
// it registered. The matchers are the bun:test ones the tests use, on chai's assertions.

import { assert } from "chai";

/** A test's body. */
export type Body = () => unknown;

/**
 * The tests a worker's file registered, in order. On the worker's global, so the file's
 * bundle and tooling/unit-worker.ts, which each have their own copy of this module, share it.
 */
const REGISTRY = Symbol.for("snowy.unit");
const scope = globalThis as typeof globalThis & { [REGISTRY]?: { name: string; body: Body }[] };
export const registry = (scope[REGISTRY] ??= []);

/** Registers a test, run in order once the file has loaded. */
export function test(name: string, body: Body) {
  registry.push({ name, body });
}

// A class `instanceof` takes, in chai's type for it.
type Class = Parameters<typeof assert.instanceOf>[1];
type Thrown = string | RegExp | Class;

const show = (value: unknown) => (typeof value === "bigint" ? `${value}n` : String(value));

function number(actual: unknown) {
  if (typeof actual !== "number") throw new TypeError(`${show(actual)} is not a number`);
  return actual;
}

function string(actual: unknown) {
  if (typeof actual !== "string") throw new TypeError(`${show(actual)} is not a string`);
  return actual;
}

// What calling `actual` throws; fails if it throws nothing.
function thrownBy(actual: unknown): unknown {
  if (typeof actual !== "function") throw new TypeError(`${show(actual)} is not a function`);

  try {
    Reflect.apply(actual, undefined, []);
  } catch (e) {
    return e;
  }

  return assert.fail("it threw nothing");
}

function matchers(actual: unknown) {
  return {
    toBe: (expected: unknown) =>
      assert(Object.is(actual, expected), `${show(actual)} is not ${show(expected)}`),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeUndefined: () => assert.isUndefined(actual),
    toBeInstanceOf: (type: Class) => assert.instanceOf(actual, type),
    toHaveLength: (length: number) =>
      assert(
        typeof actual === "object" &&
          actual !== null &&
          "length" in actual &&
          actual.length === length,
        `length is not ${length}`,
      ),
    toBeLessThan: (n: number) => assert.isBelow(number(actual), n),
    toBeGreaterThan: (n: number) => assert.isAbove(number(actual), n),
    // As bun:test: within half a unit of the `digits`th decimal place.
    toBeCloseTo: (n: number, digits = 2) =>
      assert.isBelow(Math.abs(number(actual) - n), 10 ** -digits / 2, `${show(actual)} ≉ ${n}`),
    toMatch: (pattern: string | RegExp) =>
      typeof pattern === "string"
        ? assert.include(string(actual), pattern)
        : assert.match(string(actual), pattern),

    toThrow: (thrown?: Thrown) => {
      const error = thrownBy(actual);
      const message = error instanceof Error ? error.message : show(error);
      if (typeof thrown === "string") assert.include(message, thrown);
      else if (thrown instanceof RegExp) assert.match(message, thrown);
      else if (thrown) assert.instanceOf(error, thrown);
    },
  };
}

/** bun:test's `expect`, with the matchers the tests use. */
export function expect(actual: unknown) {
  return {
    ...matchers(actual),
    not: {
      toBe: (expected: unknown) =>
        assert(!Object.is(actual, expected), `${show(actual)} is ${show(expected)}`),
      toEqual: (expected: unknown) => assert.notDeepEqual(actual, expected),
    },
  };
}
