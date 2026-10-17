// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LGPL-2.1-or-later

const BLOCK_DECLARATIONS = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "TryStatement",
  "SwitchStatement",
  "BlockStatement",
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
  "TSDeclareFunction",
]);
const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

function isBlockFunction(node) {
  const isFunction =
    node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";
  return isFunction && node.body.type === "BlockStatement";
}

function endsWithBlock(node) {
  if (!node) return false;
  if (BLOCK_DECLARATIONS.has(node.type)) return true;
  if (LOOPS.has(node.type)) return node.body.type === "BlockStatement";

  switch (node.type) {
    case "IfStatement":
      return endsWithBlock(node.alternate ?? node.consequent);
    case "LabeledStatement":
      return endsWithBlock(node.body);
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return endsWithBlock(node.declaration);
    case "VariableDeclaration":
      return isBlockFunction(node.declarations.at(-1)?.init);
    case "ExpressionStatement":
      return (
        node.expression.type === "AssignmentExpression" && isBlockFunction(node.expression.right)
      );
    case "TSTypeAliasDeclaration":
      return node.typeAnnotation.type === "TSTypeLiteral";
    default:
      return false;
  }
}

function isMultilineBlock(node) {
  return node.loc.start.line < node.loc.end.line && endsWithBlock(node);
}

export default {
  meta: {
    type: "layout",
    schema: [],
    fixable: "whitespace",
    messages: {
      blankLine: "Separate a multi-line block from the statement next to it with a blank line.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const text = source.text ?? source.getText();

    function check(body) {
      for (let index = 1; index < body.length; index += 1) {
        const previous = body[index - 1];
        const next = body[index];
        const needsBlank = isMultilineBlock(previous) || isMultilineBlock(next);
        if (!needsBlank) continue;
        const gap = text.slice(previous.range[1], next.range[0]);
        if (/\n[ \t]*\n/.test(gap)) continue;
        const lineEnd = previous.range[1] + gap.indexOf("\n") + 1;
        context.report({
          node: next,
          messageId: "blankLine",
          fix: (fixer) => fixer.insertTextBeforeRange([lineEnd, lineEnd], "\n"),
        });
      }
    }

    return {
      Program: (node) => check(node.body),
      BlockStatement: (node) => check(node.body),
      StaticBlock: (node) => check(node.body),
    };
  },
};
