// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later

const HOSTS = new Set([
  "VariableDeclarator",
  "AssignmentExpression",
  "ReturnStatement",
  "ExpressionStatement",
  "ArrowFunctionExpression",
  "ThrowStatement",
  "ForOfStatement",
  "AwaitExpression",
]);

const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression"]);

function host(node) {
  let parent = node.parent;
  while (WRAPPERS.has(parent?.type)) parent = parent.parent;
  return parent;
}

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      nested:
        "An `await` inside a larger expression hides the pause. Await into a `const` first, then use the value.",
    },
  },
  create(context) {
    return {
      AwaitExpression(node) {
        if (HOSTS.has(host(node)?.type)) return;
        context.report({ node, messageId: "nested" });
      },
    };
  },
};
