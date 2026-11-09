/**
 * 导出声明公开契约可命名（specs/server-crud-service-boundary.md 验收 24）。
 *
 * 导出函数、接口、类型别名、类与变量单例的公开签名/成员/推断类型如果引用本文件
 * 定义的命名类型，该类型必须导出：否则调用方无法命名该契约，只能重写形状，导致
 * 结构相同却多处维护。扫描范围仅限 server/ 生产代码；测试、生成代码与依赖目录不参与。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { REPO_ROOT, toRepoPath, walk, writeTree } from "../helpers/repo-source";

interface Violation {
  /** 仓库根相对路径（统一 `/` 分隔） */
  file: string;
  line: number;
  /** 导出声明/成员的展示名 */
  signature: string;
  /** 公开契约引用的未导出本文件类型 */
  typeName: string;
}

type LocalKind = "interface" | "type" | "class" | "enum" | "namespace";

interface LocalType {
  exported: boolean;
  kind: LocalKind;
}

interface Context {
  sourceFile: ts.SourceFile;
  rel: string;
  declared: Map<string, LocalType>;
  exportedByClause: Set<string>;
  values: Map<string, ts.Declaration>;
  violations: Violation[];
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** 无模块说明符的具名导出子句中的本地名称。 */
function namedExportClause(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text);
      }
    }
  }
  return names;
}

/** 本文件定义的命名类型 → 是否导出与类型种类。 */
function localTypes(sourceFile: ts.SourceFile, exportedByClause: Set<string>): Map<string, LocalType> {
  const declared = new Map<string, LocalType>();
  for (const statement of sourceFile.statements) {
    let name: string | undefined;
    let kind: LocalKind;
    if (ts.isInterfaceDeclaration(statement)) {
      name = statement.name.text;
      kind = "interface";
    } else if (ts.isTypeAliasDeclaration(statement)) {
      name = statement.name.text;
      kind = "type";
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      name = statement.name.text;
      kind = "class";
    } else if (ts.isEnumDeclaration(statement)) {
      name = statement.name.text;
      kind = "enum";
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      name = statement.name.text;
      kind = "namespace";
    } else {
      continue;
    }
    declared.set(name, {
      kind,
      exported:
        hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ||
        exportedByClause.has(name),
    });
  }
  return declared;
}

/** 顶层值声明 → 声明节点：用于追踪导出变量初始化器的推断类型。 */
function localValues(sourceFile: ts.SourceFile): Map<string, ts.Declaration> {
  const values = new Map<string, ts.Declaration>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      values.set(statement.name.text, statement);
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      values.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) values.set(declaration.name.text, declaration);
      }
    }
  }
  return values;
}

function isExported(node: ts.Node, exportedByClause: Set<string>, name?: string): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword) ||
    (name !== undefined && exportedByClause.has(name))
  );
}

function propertyLabel(name: ts.Node | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (name === undefined) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function memberNameOf(member: ts.Node): ts.PropertyName | undefined {
  return "name" in member ? ((member as ts.NamedDeclaration).name as ts.PropertyName | undefined) : undefined;
}

function leftmostName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isQualifiedName(node)) return leftmostName(node.left);
  if (ts.isPropertyAccessExpression(node)) return leftmostName(node.expression);
  return undefined;
}

function collectTypeRefs(type: ts.TypeNode | undefined, refs: Set<string>): void {
  if (type === undefined) return;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = leftmostName(node.typeName);
      if (name !== undefined) refs.add(name);
    } else if (ts.isTypeQueryNode(node)) {
      const name = leftmostName(node.exprName);
      if (name !== undefined) refs.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(type);
}

function collectTypeParameterRefs(
  parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  refs: Set<string>,
): void {
  for (const parameter of parameters ?? []) {
    collectTypeRefs(parameter.constraint, refs);
    collectTypeRefs(parameter.default, refs);
  }
}

function collectHeritageRefs(clauses: ts.NodeArray<ts.HeritageClause> | undefined, refs: Set<string>): void {
  for (const clause of clauses ?? []) {
    for (const type of clause.types) {
      const name = leftmostName(type.expression);
      if (name !== undefined) refs.add(name);
      for (const argument of type.typeArguments ?? []) collectTypeRefs(argument, refs);
    }
  }
}

function signatureRefs(node: ts.SignatureDeclaration): Set<string> {
  const refs = new Set<string>();
  for (const parameter of node.parameters) collectTypeRefs(parameter.type, refs);
  collectTypeRefs(node.type, refs);
  collectTypeParameterRefs(node.typeParameters, refs);
  return refs;
}

function checkRefs(context: Context, refs: Set<string>, node: ts.Node, signature: string): void {
  for (const ref of refs) {
    const local = context.declared.get(ref);
    if (local !== undefined && !local.exported) {
      context.violations.push({
        file: context.rel,
        line: lineOf(context.sourceFile, node),
        signature,
        typeName: ref,
      });
    }
  }
}

function addViolation(context: Context, node: ts.Node, signature: string, typeName: string): void {
  context.violations.push({
    file: context.rel,
    line: lineOf(context.sourceFile, node),
    signature,
    typeName,
  });
}

function checkSignature(context: Context, node: ts.SignatureDeclaration, signature: string): void {
  checkRefs(context, signatureRefs(node), node, signature);
}

function checkInterface(context: Context, node: ts.InterfaceDeclaration): void {
  const name = node.name.text;
  const headerRefs = new Set<string>();
  collectTypeParameterRefs(node.typeParameters, headerRefs);
  collectHeritageRefs(node.heritageClauses, headerRefs);
  checkRefs(context, headerRefs, node, name);

  for (const member of node.members) {
    const label = propertyLabel(memberNameOf(member), context.sourceFile);
    const signature = label === undefined ? name : `${name}.${label}`;
    if (ts.isPropertySignature(member)) {
      const refs = new Set<string>();
      collectTypeRefs(member.type, refs);
      checkRefs(context, refs, member, signature);
    } else if (
      ts.isMethodSignature(member) ||
      ts.isCallSignatureDeclaration(member) ||
      ts.isConstructSignatureDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      checkSignature(context, member, signature);
    } else if (ts.isIndexSignatureDeclaration(member)) {
      const refs = new Set<string>();
      for (const parameter of member.parameters) collectTypeRefs(parameter.type, refs);
      collectTypeRefs(member.type, refs);
      checkRefs(context, refs, member, signature);
    }
  }
}

function checkTypeAlias(context: Context, node: ts.TypeAliasDeclaration): void {
  const refs = new Set<string>();
  collectTypeParameterRefs(node.typeParameters, refs);
  collectTypeRefs(node.type, refs);
  checkRefs(context, refs, node, node.name.text);
}

function checkClass(context: Context, node: ts.ClassDeclaration | ts.ClassExpression, name: string): void {
  const headerRefs = new Set<string>();
  collectTypeParameterRefs(node.typeParameters, headerRefs);
  collectHeritageRefs(node.heritageClauses, headerRefs);
  checkRefs(context, headerRefs, node, name);

  for (const member of node.members) {
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
    const label = propertyLabel(memberNameOf(member), context.sourceFile);
    const signature = ts.isConstructorDeclaration(member)
      ? `${name}.constructor`
      : label === undefined ? name : `${name}.${label}`;
    if (ts.isConstructorDeclaration(member)) {
      const refs = new Set<string>();
      for (const parameter of member.parameters) {
        if (hasModifier(parameter, ts.SyntaxKind.PrivateKeyword)) continue;
        collectTypeRefs(parameter.type, refs);
      }
      checkRefs(context, refs, member, signature);
    } else if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      checkSignature(context, member, signature);
    } else if (ts.isPropertyDeclaration(member)) {
      const refs = new Set<string>();
      collectTypeRefs(member.type, refs);
      checkRefs(context, refs, member, signature);
      if (member.type === undefined) inspectInitializer(context, member.initializer, signature);
    } else if (ts.isIndexSignatureDeclaration(member)) {
      const refs = new Set<string>();
      for (const parameter of member.parameters) collectTypeRefs(parameter.type, refs);
      collectTypeRefs(member.type, refs);
      checkRefs(context, refs, member, signature);
    }
  }
}

function inspectObjectLiteral(context: Context, expression: ts.ObjectLiteralExpression, signature: string): void {
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      inspectInitializer(context, property.expression, signature);
      continue;
    }
    const label = propertyLabel(memberNameOf(property), context.sourceFile);
    const nested = label === undefined ? signature : `${signature}.${label}`;
    if (ts.isPropertyAssignment(property)) {
      inspectInitializer(context, property.initializer, nested);
    } else if (
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      checkSignature(context, property, nested);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      const local = context.values.get(property.name.text);
      if (local !== undefined) {
        if (ts.isClassDeclaration(local) && !isExported(local, context.exportedByClause, local.name?.text)) {
          addViolation(context, property, nested, property.name.text);
        } else if (
          ts.isFunctionDeclaration(local) &&
          !isExported(local, context.exportedByClause, local.name?.text)
        ) {
          addViolation(context, property, nested, `<inferred:${property.name.text}>`);
        }
      }
    }
  }
}

/** 函数值变量声明上的显式返回类型（标注写在箭头/函数表达式上，而非变量声明上）。 */
function functionReturnType(expression: ts.Expression | undefined): ts.TypeNode | undefined {
  if (expression === undefined) return undefined;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression.type;
  return undefined;
}

function inspectInitializer(context: Context, expression: ts.Expression | undefined, signature: string): void {
  if (expression === undefined) return;

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    checkSignature(context, expression, signature);
    return;
  }
  if (ts.isClassExpression(expression)) {
    checkClass(context, expression, signature);
    return;
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    const refs = new Set<string>();
    collectTypeRefs(expression.type, refs);
    checkRefs(context, refs, expression, signature);
    inspectInitializer(context, expression.expression, signature);
    return;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    inspectObjectLiteral(context, expression, signature);
    return;
  }
  if (ts.isNewExpression(expression)) {
    const refs = new Set<string>();
    for (const argument of expression.typeArguments ?? []) collectTypeRefs(argument, refs);
    checkRefs(context, refs, expression, signature);
    const target = leftmostName(expression.expression);
    if (target !== undefined) {
      const local = context.declared.get(target);
      if (local !== undefined && local.kind === "class" && !local.exported) {
        addViolation(context, expression, signature, target);
      }
    }
    return;
  }
  if (ts.isCallExpression(expression)) {
    const refs = new Set<string>();
    for (const argument of expression.typeArguments ?? []) collectTypeRefs(argument, refs);
    checkRefs(context, refs, expression, signature);
    if (ts.isIdentifier(expression.expression)) {
      const callee = expression.expression.text;
      const declaration = context.values.get(callee);
      if (declaration !== undefined) {
        if (ts.isFunctionDeclaration(declaration)) {
          if (declaration.type !== undefined) {
            const returnRefs = new Set<string>();
            collectTypeRefs(declaration.type, returnRefs);
            checkRefs(context, returnRefs, expression, signature);
          } else {
            addViolation(context, expression, signature, `<inferred:${callee}>`);
          }
        } else if (ts.isVariableDeclaration(declaration)) {
          const returnType = declaration.type ?? functionReturnType(declaration.initializer);
          if (returnType !== undefined) {
            const typeRefs = new Set<string>();
            collectTypeRefs(returnType, typeRefs);
            checkRefs(context, typeRefs, expression, signature);
          } else {
            addViolation(context, expression, signature, `<inferred:${callee}>`);
          }
        }
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) inspectInitializer(context, element, signature);
    return;
  }
  if (ts.isParenthesizedExpression(expression)) {
    inspectInitializer(context, expression.expression, signature);
    return;
  }
  if (ts.isConditionalExpression(expression)) {
    inspectInitializer(context, expression.whenTrue, signature);
    inspectInitializer(context, expression.whenFalse, signature);
    return;
  }
  if (ts.isIdentifier(expression)) {
    const declaration = context.values.get(expression.text);
    if (declaration === undefined) return;
    if (ts.isClassDeclaration(declaration)) {
      if (!isExported(declaration, context.exportedByClause, declaration.name?.text)) {
        addViolation(context, expression, signature, expression.text);
      }
    } else if (ts.isFunctionDeclaration(declaration)) {
      if (declaration.type !== undefined) {
        const refs = new Set<string>();
        collectTypeRefs(declaration.type, refs);
        checkRefs(context, refs, expression, signature);
      } else if (!isExported(declaration, context.exportedByClause, declaration.name?.text)) {
        addViolation(context, expression, signature, `<inferred:${expression.text}>`);
      }
    } else if (ts.isVariableDeclaration(declaration)) {
      const type = declaration.type ?? functionReturnType(declaration.initializer);
      if (type !== undefined) {
        const refs = new Set<string>();
        collectTypeRefs(type, refs);
        checkRefs(context, refs, expression, signature);
      }
    }
  }
}

function checkVariableDeclaration(
  context: Context,
  declaration: ts.VariableDeclaration,
  statement: ts.VariableStatement,
): void {
  const exported =
    hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
    (ts.isIdentifier(declaration.name) && context.exportedByClause.has(declaration.name.text));
  if (!exported) return;

  const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "<destructured>";
  if (declaration.type !== undefined) {
    const refs = new Set<string>();
    collectTypeRefs(declaration.type, refs);
    checkRefs(context, refs, declaration, name);
    return;
  }
  if (ts.isObjectBindingPattern(declaration.name) || ts.isArrayBindingPattern(declaration.name)) {
    // 解构导出的公开类型由初始化器推断；没有类型标注时无法静态确认可命名性，fail-closed。
    addViolation(context, declaration, name, "<destructured>");
    return;
  }
  inspectInitializer(context, declaration.initializer, name);
}

function moduleName(node: ts.ModuleDeclaration): string {
  return node.name.text;
}

/** 与区域设置无关的稳定排序：负例断言依赖跨平台一致的顺序。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectViolations(root: string): Violation[] {
  const files: string[] = [];
  walk(path.join(root, "server"), files);

  const violations: Violation[] = [];

  for (const abs of files) {
    const sourceFile = ts.createSourceFile(
      abs,
      readFileSync(abs, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const exportedByClause = namedExportClause(sourceFile);
    const declared = localTypes(sourceFile, exportedByClause);
    const context: Context = {
      sourceFile,
      rel: toRepoPath(root, abs),
      declared,
      exportedByClause,
      values: localValues(sourceFile),
      violations,
    };

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        const name = statement.name?.text ?? "<default>";
        if (isExported(statement, exportedByClause, statement.name?.text)) {
          checkSignature(context, statement, name);
        }
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          checkVariableDeclaration(context, declaration, statement);
        }
        continue;
      }

      if (ts.isInterfaceDeclaration(statement)) {
        if (isExported(statement, exportedByClause, statement.name.text)) {
          checkInterface(context, statement);
        }
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        if (isExported(statement, exportedByClause, statement.name.text)) {
          checkTypeAlias(context, statement);
        }
        continue;
      }

      if (ts.isClassDeclaration(statement)) {
        const name = statement.name?.text ?? "<default>";
        if (isExported(statement, exportedByClause, statement.name?.text)) {
          checkClass(context, statement, name);
        }
        continue;
      }

      if (ts.isModuleDeclaration(statement)) {
        const name = moduleName(statement);
        // namespace/module 的内部导出形态无法用本检查器逐一确认，fail-closed。
        if (isExported(statement, exportedByClause, name)) {
          addViolation(context, statement, name, "<namespace>");
        }
        continue;
      }

      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) {
          addViolation(context, statement, "<export=>", "<export=>");
        } else {
          inspectInitializer(context, statement.expression, "<default>");
        }
      }
    }
  }

  return violations.sort(
    (left, right) =>
      compareText(left.file, right.file) ||
      left.line - right.line ||
      compareText(left.typeName, right.typeName) ||
      compareText(left.signature, right.signature),
  );
}

function formatViolations(violations: Violation[]): string[] {
  return violations.map(
    (violation) => `${violation.file}:${violation.line} ${violation.signature} -> ${violation.typeName}`,
  );
}

function formatViolationSites(violations: Violation[]): string[] {
  return violations.map(
    (violation) => `${violation.file} ${violation.signature} -> ${violation.typeName}`,
  );
}

/**
 * 以 TypeScript 声明发射作为公开契约的事实来源：推断返回、对象简写等被编译器解析后
 * 都会变成显式声明，再用同一 AST 检查器扫描 `.d.ts`。这补上了纯源码 AST 无法推断的
 * “推断类型”分支（验收 24）。
 */
function emitDeclarations(tsconfigPath: string, outRoot: string): void {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const projectRoot = path.dirname(tsconfigPath);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    );
  }

  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    outDir: outRoot,
    rootDir: projectRoot,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
  });

  let emittedCount = 0;
  const emitResult = program.emit(
    undefined,
    (fileName, data) => {
      if (!fileName.endsWith(".d.ts")) return;
      const target = path.isAbsolute(fileName) ? fileName : path.resolve(outRoot, fileName);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data, "utf8");
      emittedCount += 1;
    },
    undefined,
    true,
  );

  if (emittedCount === 0 || emitResult.diagnostics.length > 0) {
    const details = emitResult.diagnostics
      .map((diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`)
      .join("\n");
    throw new Error(`declaration emit failed (emitted=${emittedCount}):\n${details}`);
  }
}

describe("架构边界：导出声明公开契约可命名", () => {
  it("server 生产代码的导出声明不在公开签名/成员/推断类型中引用未导出的本文件类型", () => {
    expect(formatViolations(collectViolations(REPO_ROOT))).toEqual([]);
  });

  // 全项目声明发射需构建完整 Program（约 320 个 .d.ts），远超默认 5s
  it("声明发射解析推断类型后仍不暴露未导出的本文件类型", { timeout: 120_000 }, () => {
    const outRoot = mkdtempSync(path.join(tmpdir(), "noxrea-declarations-"));
    try {
      emitDeclarations(path.join(REPO_ROOT, "tsconfig.json"), outRoot);
      expect(formatViolations(collectViolations(outRoot))).toEqual([]);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });
});

describe("声明发射负例：推断类型", () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "noxrea-inferred-source-"));
  const emitRoot = mkdtempSync(path.join(tmpdir(), "noxrea-inferred-emit-"));

  writeTree(sourceRoot, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["server/**/*.ts"],
    }),
    "server/crud/inferred-return.ts": [
      "interface PrivateInferred { value: string }",
      "export function inferred() { return { value: \"\" } as PrivateInferred; }",
    ].join("\n"),
    "server/crud/shorthand.ts": [
      "interface PrivateShorthand { value: string }",
      "const localPrivate: PrivateShorthand = { value: \"\" };",
      "export const o = { localPrivate };",
    ].join("\n"),
  });

  afterAll(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(emitRoot, { recursive: true, force: true });
  });

  it("推断返回与对象简写在发射声明中暴露私有类型时失败", () => {
    emitDeclarations(path.join(sourceRoot, "tsconfig.json"), emitRoot);
    expect(formatViolationSites(collectViolations(emitRoot))).toEqual([
      "server/crud/inferred-return.d.ts inferred -> PrivateInferred",
      "server/crud/shorthand.d.ts o -> PrivateShorthand",
    ]);
  });
});

describe("导出签名检查器负例", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "noxrea-exported-signatures-"));

  writeTree(fixtureRoot, {
    "server/crud/private-signature.ts": [
      "interface PrivateValue { value: string }",
      "export function privateParam(input: PrivateValue): void {}",
      "export function privateReturn(): PrivateValue { return { value: \"\" }; }",
      "export const privateArrow = (input: PrivateValue): void => {};",
      "function internalOnly(input: PrivateValue): void {}",
    ].join("\n"),
    "server/crud/clause-signature.ts": [
      "interface ClausePrivate { value: string }",
      "function clauseExported(input: ClausePrivate): void {}",
      "export { clauseExported };",
    ].join("\n"),
    "server/crud/exported-signature.ts": [
      "export interface PublicValue { value: string }",
      "interface ClauseValue { value: string }",
      "export type { ClauseValue };",
      "export function publicParam(input: PublicValue): void {}",
      "export function clauseParam(input: ClauseValue): void {}",
    ].join("\n"),
    "server/crud/interface-members.ts": [
      "interface PrivateMember { value: string }",
      "export interface ExportedInterface {",
      "  method(input: PrivateMember): void;",
      "  property: PrivateMember;",
      "  nested: { inner: PrivateMember };",
      "}",
    ].join("\n"),
    "server/crud/type-alias.ts": [
      "interface PrivateAlias { value: string }",
      "export type ExportedAlias = { inner: PrivateAlias };",
    ].join("\n"),
    "server/crud/class-members.ts": [
      "interface PrivateClassType { value: string }",
      "export class ExportedClass {",
      "  method(input: PrivateClassType): void {}",
      "  private hidden(input: PrivateClassType): void {}",
      "  protected guarded(input: PrivateClassType): void {}",
      "  constructor(public value: PrivateClassType) {}",
      "  property: PrivateClassType;",
      "}",
    ].join("\n"),
    "server/crud/class-expression.ts": [
      "interface PrivateExpression { value: string }",
      "export const classValue = class {",
      "  method(input: PrivateExpression): void {}",
      "};",
    ].join("\n"),
    "server/crud/default-class.ts": [
      "interface PrivateDefaultClass { value: string }",
      "export default class {",
      "  method(input: PrivateDefaultClass): void {}",
      "}",
    ].join("\n"),
    "server/crud/default-export.ts": [
      "interface PrivateDefault { value: string }",
      "export default function defaultFn(input: PrivateDefault): void {}",
    ].join("\n"),
    "server/crud/interface-extends.ts": [
      "interface PrivateBase { value: string }",
      "export interface ExportedChild extends PrivateBase {",
      "  other: string;",
      "}",
    ].join("\n"),
    "server/crud/interface-typeparam.ts": [
      "interface PrivateInterfaceConstraint { value: string }",
      "export interface ExportedInterfaceGeneric<T extends PrivateInterfaceConstraint> { value: T; }",
    ].join("\n"),
    "server/crud/type-params.ts": [
      "interface PrivateConstraint { value: string }",
      "export type ExportedGeneric<T extends PrivateConstraint> = T;",
    ].join("\n"),
    "server/crud/overload.ts": [
      "interface PrivateOverload { value: string }",
      "export function overloaded(input: PrivateOverload): void;",
      "export function overloaded(input: string): void;",
      "export function overloaded(input: PrivateOverload | string): void {}",
    ].join("\n"),
    "server/crud/class-heritage.ts": [
      "interface PrivateIface { value: string }",
      "export class ExportedImpl implements PrivateIface {",
      "  value = \"\";",
      "}",
    ].join("\n"),
    "server/crud/class-typeparam.ts": [
      "interface PrivateClassConstraint { value: string }",
      "export class ExportedClassGeneric<T extends PrivateClassConstraint> {",
      "  value!: T;",
      "}",
    ].join("\n"),
    "server/crud/variable-initializers.ts": [
      "interface PrivateVar { value: string }",
      "class PrivateClass { value = \"\"; }",
      "function makePrivate(): PrivateVar { return { value: \"\" }; }",
      "function makeUnannotated() { return { value: \"\" }; }",
      "const localPrivate: PrivateVar = { value: \"\" };",
      "export const asValue = { value: \"\" } as PrivateVar;",
      "export const satisfiesValue = { value: \"\" } satisfies PrivateVar;",
      "export const objectValue = { method(input: PrivateVar): void {} };",
      "export const newValue = new PrivateClass();",
      "export const callValue = makePrivate();",
      "export const inferredCall = makeUnannotated();",
      "export const identifierValue = localPrivate;",
      "export const { destructured } = localPrivate;",
      "export const typedValue: PrivateVar = { value: \"\" };",
    ].join("\n"),
    "server/crud/typeof-qualified.ts": [
      "class PrivateClass {}",
      "namespace PrivateNs { export interface Value { value: string } }",
      "export type TypeOfPrivate = typeof PrivateClass;",
      "export type QualifiedPrivate = PrivateNs.Value;",
    ].join("\n"),
    "server/crud/namespace-export.ts": [
      "export namespace ExportedNs { export function fn(): void {} }",
    ].join("\n"),
    "server/crud/export-equals.ts": [
      "const value = 1;",
      "export = value;",
    ].join("\n"),
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const violations = collectViolations(fixtureRoot);

  it("私有类型出现在函数、接口、类型别名、类与变量契约中都会失败，私有成员不受影响", () => {
    expect(formatViolations(violations)).toEqual([
      "server/crud/class-expression.ts:3 classValue.method -> PrivateExpression",
      "server/crud/class-heritage.ts:2 ExportedImpl -> PrivateIface",
      "server/crud/class-members.ts:3 ExportedClass.method -> PrivateClassType",
      "server/crud/class-members.ts:5 ExportedClass.guarded -> PrivateClassType",
      "server/crud/class-members.ts:6 ExportedClass.constructor -> PrivateClassType",
      "server/crud/class-members.ts:7 ExportedClass.property -> PrivateClassType",
      "server/crud/class-typeparam.ts:2 ExportedClassGeneric -> PrivateClassConstraint",
      "server/crud/clause-signature.ts:2 clauseExported -> ClausePrivate",
      "server/crud/default-class.ts:3 <default>.method -> PrivateDefaultClass",
      "server/crud/default-export.ts:2 defaultFn -> PrivateDefault",
      "server/crud/export-equals.ts:2 <export=> -> <export=>",
      "server/crud/interface-extends.ts:2 ExportedChild -> PrivateBase",
      "server/crud/interface-members.ts:3 ExportedInterface.method -> PrivateMember",
      "server/crud/interface-members.ts:4 ExportedInterface.property -> PrivateMember",
      "server/crud/interface-members.ts:5 ExportedInterface.nested -> PrivateMember",
      "server/crud/interface-typeparam.ts:2 ExportedInterfaceGeneric -> PrivateInterfaceConstraint",
      "server/crud/namespace-export.ts:1 ExportedNs -> <namespace>",
      "server/crud/overload.ts:2 overloaded -> PrivateOverload",
      "server/crud/overload.ts:4 overloaded -> PrivateOverload",
      "server/crud/private-signature.ts:2 privateParam -> PrivateValue",
      "server/crud/private-signature.ts:3 privateReturn -> PrivateValue",
      "server/crud/private-signature.ts:4 privateArrow -> PrivateValue",
      "server/crud/type-alias.ts:2 ExportedAlias -> PrivateAlias",
      "server/crud/type-params.ts:2 ExportedGeneric -> PrivateConstraint",
      "server/crud/typeof-qualified.ts:3 TypeOfPrivate -> PrivateClass",
      "server/crud/typeof-qualified.ts:4 QualifiedPrivate -> PrivateNs",
      "server/crud/variable-initializers.ts:6 asValue -> PrivateVar",
      "server/crud/variable-initializers.ts:7 satisfiesValue -> PrivateVar",
      "server/crud/variable-initializers.ts:8 objectValue.method -> PrivateVar",
      "server/crud/variable-initializers.ts:9 newValue -> PrivateClass",
      "server/crud/variable-initializers.ts:10 callValue -> PrivateVar",
      "server/crud/variable-initializers.ts:11 inferredCall -> <inferred:makeUnannotated>",
      "server/crud/variable-initializers.ts:12 identifierValue -> PrivateVar",
      "server/crud/variable-initializers.ts:13 <destructured> -> <destructured>",
      "server/crud/variable-initializers.ts:14 typedValue -> PrivateVar",
    ]);
  });

  it("导出类型与具名导出子句不会误报", () => {
    expect(violations.some((violation) => violation.file === "server/crud/exported-signature.ts")).toBe(false);
  });
});
