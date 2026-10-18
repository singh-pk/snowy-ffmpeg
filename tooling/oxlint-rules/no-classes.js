// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT

// Classes that extend something (errors, library bases) are allowed.
export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      noClass:
        "Classes are banned. Write a factory function that returns an object. Only classes that extend something are allowed.",
    },
  },
  create(context) {
    function check(node) {
      if (!node.superClass) context.report({ node, messageId: "noClass" });
    }

    return { ClassDeclaration: check, ClassExpression: check };
  },
};
