#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = fileURLToPath(new URL("../src", import.meta.url));
const references = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.tsx?$/.test(file)) continue;
    const filePath = relative(root, file).replaceAll("\\", "/");
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let source;
      let kind = "runtime";
      let mixedTypes = false;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        source = node.moduleSpecifier;
        if (node.isTypeOnly || node.importClause?.isTypeOnly) kind = "type";
        else if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          const items = node.importClause.namedBindings.elements;
          if (!node.importClause.name && items.length && items.every((item) => item.isTypeOnly)) kind = "type";
          else mixedTypes = items.some((item) => item.isTypeOnly);
        }
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        source = node.arguments[0];
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        source = node.argument.literal;
        kind = "type";
      }
      if (source && ts.isStringLiteral(source) && /^(antd(?:\/|$)|@ant-design\/icons(?:\/|$))/.test(source.text)) {
        references.push({ filePath, dependency: source.text.startsWith("antd") ? "antd" : "icons", kind });
        if (mixedTypes) references.push({ filePath, dependency: source.text.startsWith("antd") ? "antd" : "icons", kind: "type" });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
walk(root);
const implementation = references.filter((item) => item.dependency === "antd" && item.filePath.startsWith("components/ui/"));
const business = references.filter((item) => item.dependency === "antd" && !item.filePath.startsWith("components/ui/") && !item.filePath.startsWith("__tests__/"));
const tests = references.filter((item) => item.dependency === "antd" && item.filePath.startsWith("__tests__/"));
console.log(`antd business: ${business.length}; UI runtime: ${implementation.filter((item) => item.kind === "runtime").length}; UI types: ${implementation.filter((item) => item.kind === "type").length}; tests: ${tests.length}`);
console.log(`Icon imports (separate dependency): ${references.filter((item) => item.dependency === "icons").length}`);
if (process.argv.includes("--list")) references.forEach((item) => console.log(`${item.dependency}\t${item.kind}\t${item.filePath}`));
if (business.length) process.exitCode = 1;
