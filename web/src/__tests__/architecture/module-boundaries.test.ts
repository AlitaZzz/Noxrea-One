/**
 * 前端模块边界（specs/web-module-contracts.md）。
 *
 * 用 TypeScript Compiler API 扫描 `web/src` 的模块引用，而不是正则：
 * 必须同时覆盖静态 `import`、`export ... from`、`import type`、`import("...")` 类型引用、
 * 动态 `import()`、`require()` 与 `import = require()`。
 * `@/` 别名与相对路径按真实文件解析；无法解析的内部说明符 fail-closed。
 *
 * 分层：app（app/providers/components/layout）、features/<name>、entities/<name>、
 * shared（components/ui|media|model、lib、types）。测试文件不豁免：`__tests__/features/<name>`
 * 与 `__tests__/entities/<name>` 归入对应模块（可使用本模块内部实现）；其余测试按 app
 * 组合层参与矩阵，跨模块只能使用公共 API。仅 `__tests__/test-utils/**` 与 `__tests__/setup.ts`
 * 属于共享脚手架（test-support），不参与分层矩阵。
 *
 * 存量违规记录在 `module-boundaries.baseline.json`，测试断言当前集合与基线逐项一致：
 * 新增违规立即失败，修复后必须同步删除基线条目（基线只能缩小）。
 * 仅在首次建立基线或删除已修复条目时，允许以
 * `NOXREA_WRITE_MODULE_BOUNDARIES_BASELINE=1` 重写，且新基必须是旧基的子集。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { sourceFiles, toPosix } from "@/__tests__/test-utils/source-scan";

type ViolationRule = "unresolved" | "layer" | "deep-import" | "alias" | "export-star" | "barrel";

interface Violation {
  /** `web/src` 相对路径，统一 `/` 分隔 */
  file: string;
  specifier: string;
  rule: ViolationRule;
  message: string;
}

interface BaselineEntry {
  file: string;
  specifier: string;
  rule: ViolationRule;
}

interface Baseline {
  version: 1;
  violations: BaselineEntry[];
  cycles: string[][];
}

type ModuleKind =
  | { layer: "app" }
  | { layer: "shared" }
  | { layer: "feature"; name: string }
  | { layer: "entity"; name: string }
  | { layer: "test-support" };

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "module-boundaries.baseline.json");

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".d.ts", "/index.ts", "/index.tsx"];

function classify(relFile: string): ModuleKind {
  if (relFile.startsWith("app/")) return { layer: "app" };
  if (relFile.startsWith("providers/")) return { layer: "app" };
  if (relFile.startsWith("components/layout/")) return { layer: "app" };
  if (relFile === "proxy.ts") return { layer: "app" };

  const feature = /^features\/([^/]+)\//.exec(relFile);
  if (feature) return { layer: "feature", name: feature[1] };

  const entity = /^entities\/([^/]+)\//.exec(relFile);
  if (entity) return { layer: "entity", name: entity[1] };

  if (
    relFile.startsWith("components/ui/") ||
    relFile.startsWith("components/media/") ||
    relFile.startsWith("components/model/") ||
    relFile.startsWith("lib/") ||
    relFile.startsWith("types/")
  ) {
    return { layer: "shared" };
  }

  const featureTest = /^__tests__\/features\/([^/]+)\//.exec(relFile);
  if (featureTest) return { layer: "feature", name: featureTest[1] };

  const entityTest = /^__tests__\/entities\/([^/]+)\//.exec(relFile);
  if (entityTest) return { layer: "entity", name: entityTest[1] };

  // 共享测试脚手架不参与分层矩阵；其余测试按组合根（app）参与，
  // 跨模块导入仍受 deep-import / alias 规则约束，不得绕过公共 API。
  if (relFile === "__tests__/setup.ts" || relFile.startsWith("__tests__/test-utils/")) {
    return { layer: "test-support" };
  }
  if (relFile.startsWith("__tests__/")) return { layer: "app" };

  // 未登记路径按 app 组合层处理，避免新增目录静默逃逸分层检查。
  return { layer: "app" };
}

function moduleRootOf(kind: ModuleKind): string | null {
  if (kind.layer === "feature") return `features/${kind.name}`;
  if (kind.layer === "entity") return `entities/${kind.name}`;
  return null;
}

function moduleKeyOf(kind: ModuleKind): string {
  if (kind.layer === "feature") return `feature:${kind.name}`;
  if (kind.layer === "entity") return `entity:${kind.name}`;
  return kind.layer;
}

function resolveFile(base: string): string | null {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ResolvedSpecifier {
  abs: string | null;
  internal: boolean;
}

function resolveSpecifier(root: string, fromFile: string, specifier: string): ResolvedSpecifier {
  if (specifier.startsWith("@/")) {
    return { abs: resolveFile(path.join(root, specifier.slice(2))), internal: true };
  }
  if (specifier.startsWith(".")) {
    return { abs: resolveFile(path.resolve(path.dirname(fromFile), specifier)), internal: true };
  }
  return { abs: null, internal: false };
}

interface ImportRecord {
  specifier: string;
  /** export declaration / dynamic import / require：无法按普通 import 处理 */
  forwarding: boolean;
  exportAll: boolean;
}

function collectImports(sourceFile: ts.SourceFile): ImportRecord[] {
  const records: ImportRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      records.push({ specifier: node.moduleSpecifier.text, forwarding: false, exportAll: false });
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        records.push({ specifier: node.moduleSpecifier.text, forwarding: true, exportAll: node.exportClause === undefined });
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import("...")` 在类型位置的 AST 是 ImportTypeNode，不是 CallExpression；
      // 漏掉它会让类型-only 深导入绕过边界检查（web/AGENTS.md 八.2.4）。
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
        records.push({ specifier: arg.literal.text, forwarding: false, exportAll: false });
      } else {
        records.push({ specifier: "<dynamic>", forwarding: false, exportAll: false });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import x = require("...")` 的 AST 是 ImportEqualsDeclaration。
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        if (ts.isStringLiteralLike(ref.expression)) {
          records.push({ specifier: ref.expression.text, forwarding: false, exportAll: false });
        } else {
          records.push({ specifier: "<dynamic>", forwarding: false, exportAll: false });
        }
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        records.push({ specifier: arg.text, forwarding: true, exportAll: false });
      } else {
        records.push({ specifier: "<dynamic>", forwarding: true, exportAll: false });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        records.push({ specifier: arg.text, forwarding: true, exportAll: false });
      } else {
        records.push({ specifier: "<dynamic>", forwarding: true, exportAll: false });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return records;
}

/**
 * 分层依赖矩阵。测试源（`__tests__/**`）归入所属 feature/entity 参与同一矩阵，
 * 但允许依赖共享测试脚手架 test-support——脚手架不属于运行时分层，生产文件
 * 仍不得依赖它。
 */
function allowsLayer(from: ModuleKind, to: ModuleKind, isTestSource: boolean): boolean {
  if (from.layer === "test-support") return true;
  if (to.layer === "test-support") return isTestSource;
  if (from.layer === "app") return true;
  if (from.layer === "shared") return to.layer === "shared";
  if (from.layer === "feature") {
    return to.layer === "shared" || to.layer === "entity" || (to.layer === "feature" && to.name === from.name);
  }
  if (from.layer === "entity") {
    return to.layer === "shared" || to.layer === "entity";
  }
  return false;
}

interface ScanResult {
  violations: Violation[];
  cycles: string[][];
}

function collectViolations(root: string): ScanResult {
  const files = sourceFiles(root);

  const violations: Violation[] = [];
  const edges = new Map<string, Set<string>>();
  const add = (file: string, specifier: string, rule: ViolationRule, message: string): void => {
    violations.push({ file, specifier, rule, message });
  };

  for (const abs of files) {
    const rel = toPosix(path.relative(root, abs));
    const kind = classify(rel);
    const moduleRoot = moduleRootOf(kind);
    const isModuleRootIndex = moduleRoot !== null && rel === `${moduleRoot}/index.ts`;

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        abs,
        readFileSync(abs, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    } catch {
      add(rel, "<unreadable>", "unresolved", "文件无法解析");
      continue;
    }

    for (const record of collectImports(sourceFile)) {
      if (record.specifier === "<dynamic>") {
        add(rel, record.specifier, "unresolved", "动态 import()/require() 的说明符不是字符串字面量，无法静态校验");
        continue;
      }

      if (isModuleRootIndex && record.exportAll) {
        add(rel, record.specifier, "export-star", "公共 API 不得使用 export *");
      }

      const resolved = resolveSpecifier(root, abs, record.specifier);
      if (resolved.internal && resolved.abs === null) {
        add(rel, record.specifier, "unresolved", "内部说明符无法解析到真实文件（fail-closed）");
        continue;
      }
      if (resolved.abs === null) continue;

      const targetRel = toPosix(path.relative(root, resolved.abs));
      const targetKind = classify(targetRel);

      const graphEntry = edges.get(rel) ?? new Set<string>();
      edges.set(rel, graphEntry);
      graphEntry.add(targetRel);

      if (kind.layer === "test-support") continue;

      const sameModule = moduleRoot !== null && moduleRootOf(targetKind) === moduleRoot;
      if (sameModule) continue;

      if (isModuleRootIndex && record.forwarding) {
        // 只禁止转发其它模块（barrel 不得成为中间人）；外部包的具名转发不改变模块归属，
        // 不在 web/AGENTS.md 八.2.1 的限制内。
        add(rel, record.specifier, "barrel", "公共 API 不得转发其它模块的导出");
      }

      if (!allowsLayer(kind, targetKind, rel.startsWith("__tests__/"))) {
        add(rel, record.specifier, "layer", `${moduleKeyOf(kind)} 不得依赖 ${moduleKeyOf(targetKind)}`);
        continue;
      }

      if (targetKind.layer === "feature" || targetKind.layer === "entity") {
        const targetRoot = moduleRootOf(targetKind);
        if (targetRoot === null) continue;
        if (targetRel !== `${targetRoot}/index.ts`) {
          add(rel, record.specifier, "deep-import", `跨模块必须走公共 API（@/${targetRoot}），实际解析到 ${targetRel}`);
          continue;
        }
        if (record.specifier !== `@/${targetRoot}`) {
          add(rel, record.specifier, "alias", `跨模块必须使用公共入口说明符 @/${targetRoot}`);
        }
      }
    }
  }

  return { violations: dedupeViolations(violations), cycles: findCycles(edges) };
}

function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const result: Violation[] = [];
  for (const violation of violations) {
    const key = violationKey(violation);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(violation);
  }
  return result;
}

function violationKey(violation: BaselineEntry): string {
  return `${violation.file}\u0000${violation.specifier}\u0000${violation.rule}`;
}

/** Tarjan 强连通分量：文件级依赖图（含 import type）中大于 1 个节点的 SCC 即循环。 */
function findCycles(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const strongConnect = (node: string): void => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue;
      if (!indexes.has(next)) {
        strongConnect(next);
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indexes.get(next) ?? 0));
      }
    }

    if (lowLinks.get(node) === indexes.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };

  for (const node of edges.keys()) {
    if (!indexes.has(node)) strongConnect(node);
  }

  return components.sort((a, b) => a.join("\n").localeCompare(b.join("\n")));
}

function formatViolations(violations: readonly (Violation | BaselineEntry)[]): string[] {
  return violations.map((violation) => {
    const message = "message" in violation ? ` ${violation.message}` : "";
    return `${violation.file} -> ${violation.specifier} [${violation.rule}]${message}`;
  });
}

function formatCycles(cycles: readonly string[][]): string[] {
  return cycles.map((cycle) => cycle.join(" -> "));
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    return { version: 1, violations: [], cycles: [] };
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function writeBaseline(baseline: Baseline): void {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function currentBaseline(scan: ScanResult): Baseline {
  return {
    version: 1,
    violations: scan.violations
      .map(({ file, specifier, rule }) => ({ file, specifier, rule }))
      .sort((a, b) => violationKey(a).localeCompare(violationKey(b))),
    cycles: scan.cycles,
  };
}

function difference<T>(left: readonly T[], right: ReadonlySet<string>, keyOf: (item: T) => string): T[] {
  return left.filter((item) => !right.has(keyOf(item)));
}

describe("架构边界：web 模块依赖", () => {
  const scan = collectViolations(SRC_ROOT);

  it("当前违规与存量基线逐项一致（新增失败，修复后必须收缩基线）", () => {
    const writeMode = process.env.NOXREA_WRITE_MODULE_BOUNDARIES_BASELINE === "1";
    const current = currentBaseline(scan);

    if (writeMode) {
      const firstCreation = !existsSync(BASELINE_PATH);
      const previous = readBaseline();
      const previousKeys = new Set(previous.violations.map(violationKey));
      const previousCycles = new Set(previous.cycles.map((cycle) => cycle.join("\n")));
      if (!firstCreation) {
        const added = difference(current.violations, previousKeys, violationKey);
        const addedCycles = difference(current.cycles, previousCycles, (cycle) => cycle.join("\n"));
        expect(formatViolations(added)).toEqual([]);
        expect(formatCycles(addedCycles)).toEqual([]);
      }
      writeBaseline(current);
      return;
    }

    const baseline = readBaseline();
    const currentKeys = new Set(current.violations.map(violationKey));
    const baselineKeys = new Set(baseline.violations.map(violationKey));
    const currentCycles = new Set(current.cycles.map((cycle) => cycle.join("\n")));
    const baselineCycles = new Set(baseline.cycles.map((cycle) => cycle.join("\n")));

    const added = difference(current.violations, baselineKeys, violationKey);
    const stale = difference(baseline.violations, currentKeys, violationKey);
    const addedCycles = difference(current.cycles, baselineCycles, (cycle) => cycle.join("\n"));
    const staleCycles = difference(baseline.cycles, currentCycles, (cycle) => cycle.join("\n"));

    expect(formatViolations(added)).toEqual([]);
    expect(formatCycles(addedCycles)).toEqual([]);
    expect(formatViolations(stale)).toEqual([]);
    expect(formatCycles(staleCycles)).toEqual([]);
  });
});

describe("架构边界：检查器负例", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "noxrea-web-boundaries-"));

  const writeTree = (files: Readonly<Record<string, string>>): void => {
    for (const [relative, content] of Object.entries(files)) {
      const abs = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
  };

  writeTree({
    "app/page.ts": 'import { a } from "@/features/a/a";\nexport const page = a;\n',
    "features/a/index.ts": 'export { a } from "./a";\n',
    "features/a/a.ts": 'export const a = 1;\n',
    "features/b/index.ts": 'import { a } from "@/features/a";\nexport const b = a;\n',
    "features/b/internal.ts": "export const internal = 1;\n",
    "features/b/consumer.ts": 'import { internal } from "@/features/b/internal";\nexport const value = internal;\n',
    "features/c/index.ts": 'export * from "@/features/a";\nexport { internal } from "@/features/b/internal";\n',
    "features/d/index.ts": 'import { internal } from "../b/internal";\nexport const d = internal;\n',
    "entities/e/index.ts": 'import { a } from "@/features/a";\nexport const e = a;\n',
    "entities/f/index.ts": 'export const f = 1;\n',
    "lib/s.ts": 'import { a } from "@/features/a";\nexport const s = a;\n',
    "features/g/cycle-a.ts": 'import { cycleB } from "./cycle-b";\nexport const cycleA = cycleB;\n',
    "features/g/cycle-b.ts": 'import { cycleA } from "./cycle-a";\nexport const cycleB = cycleA;\n',
    "features/g/broken.ts": 'export async function load(): Promise<unknown> {\n  return import("@/features/missing");\n}\n',
    "features/h/index.ts": 'export { useState } from "react";\n',
    "__tests__/features/a/a.test.ts": 'import { a } from "@/features/a/a";\nexport const t = a;\n',
    "__tests__/components/cross.test.ts": 'import { internal } from "@/features/b/internal";\nexport const t = internal;\n',
    "__tests__/test-utils/helper.ts": 'import { internal } from "@/features/b/internal";\nexport const h = internal;\n',
    "app/type-consumer.ts": 'export type T = import("@/features/b/internal").Internal;\n',
    "app/import-equals.ts": 'import internal = require("@/features/b/internal");\nexport const value = internal;\n',
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const scan = collectViolations(fixtureRoot);
  const has = (predicate: (violation: Violation) => boolean): boolean => scan.violations.some(predicate);

  it("feature 之间禁止互相依赖，跨模块必须使用公共入口", () => {
    expect(has((v) => v.file === "features/b/index.ts" && v.rule === "layer")).toBe(true);
    expect(has((v) => v.file === "features/d/index.ts" && v.rule === "layer")).toBe(true);
    expect(has((v) => v.file === "app/page.ts" && v.rule === "deep-import")).toBe(true);
  });

  it("类型位置 import(...) 与 import = require 参与同一边界检查", () => {
    expect(has((v) => v.file === "app/type-consumer.ts" && v.rule === "deep-import")).toBe(true);
    expect(has((v) => v.file === "app/import-equals.ts" && v.rule === "deep-import")).toBe(true);
  });

  it("公共 API 禁止 export *、禁止转发其它模块，但允许外部包具名转发", () => {
    expect(has((v) => v.file === "features/c/index.ts" && v.rule === "export-star")).toBe(true);
    expect(has((v) => v.file === "features/c/index.ts" && v.rule === "barrel")).toBe(true);
    expect(has((v) => v.file === "features/c/index.ts" && v.rule === "layer")).toBe(true);
    expect(has((v) => v.file === "features/h/index.ts")).toBe(false);
  });

  it("entity/shared 反向依赖 feature 失败", () => {
    expect(has((v) => v.file === "entities/e/index.ts" && v.rule === "layer")).toBe(true);
    expect(has((v) => v.file === "lib/s.ts" && v.rule === "layer")).toBe(true);
  });

  it("文件级循环与无法解析的动态导入 fail-closed", () => {
    expect(scan.cycles.some((cycle) => cycle.includes("features/g/cycle-a.ts") && cycle.includes("features/g/cycle-b.ts"))).toBe(true);
    expect(has((v) => v.file === "features/g/broken.ts" && v.rule === "unresolved")).toBe(true);
  });

  it("测试文件按归属模块参与分层，组合层测试不得绕过公共 API", () => {
    expect(has((v) => v.file === "__tests__/components/cross.test.ts" && v.rule === "deep-import")).toBe(true);
    expect(has((v) => v.file === "__tests__/features/a/a.test.ts")).toBe(false);
    expect(has((v) => v.file === "__tests__/test-utils/helper.ts")).toBe(false);
  });
});
