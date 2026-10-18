// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      awaitAssertion:
        "Do not assert the type of an awaited value inline. Await into a binding on its own line, then annotate or assert that binding.",
    },
  },
  create(context) {
    function report(node) {
      context.report({ node: node.parent, messageId: "awaitAssertion" });
    }

    return {
      "TSAsExpression > AwaitExpression.expression": report,
      "TSTypeAssertion > AwaitExpression.expression": report,
    };
  },
};
