// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later

export default {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      forbidden:
        "Do not use the TypeScript '{{modifier}}' access modifier. Omit public modifiers and use native #private members for encapsulation.",
    },
  },
  create(context) {
    return {
      "[accessibility]"(node) {
        if (["public", "private", "protected"].includes(node.accessibility))
          context.report({
            node,
            messageId: "forbidden",
            data: { modifier: node.accessibility },
          });
      },
    };
  },
};
