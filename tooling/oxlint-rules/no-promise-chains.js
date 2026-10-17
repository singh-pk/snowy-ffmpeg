// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later

const CHAIN_METHODS = new Set(["then", "catch", "finally"]);

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      chain:
        "Do not chain `.{{ method }}` on a promise. `await` it inside `try`/`catch`/`finally`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const method = callee.property.name;
        if (!CHAIN_METHODS.has(method)) return;
        context.report({
          node: callee.property,
          messageId: "chain",
          data: { method },
        });
      },
    };
  },
};
