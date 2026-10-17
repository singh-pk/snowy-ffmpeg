// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      moduleLet:
        "Module-level `let` is a mutable singleton. Hold the state inside a factory (createX) and return it, or make the binding `const`.",
    },
  },
  create(context) {
    function report(node) {
      context.report({ node, messageId: "moduleLet" });
    }

    return {
      "Program > VariableDeclaration[kind='let']": report,
      "Program > ExportNamedDeclaration > VariableDeclaration[kind='let']": report,
    };
  },
};
