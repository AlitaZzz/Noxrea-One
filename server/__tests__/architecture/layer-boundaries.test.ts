/**
 * 服务端分层依赖边界（specs/server-crud-service-boundary.md）。
 *
 * 用 TypeScript Compiler API 扫描 `server/` 与 `shared/` 的模块引用，而不是正则：
 * 必须同时覆盖静态 `import`、`export ... from`、`import type`、`import x = require()`、
 * `typeof import()` 类型查询与动态 `import()`。
 * 相对路径与 `@server/*`、`@noxrea/shared/*` 说明符必须能解析到真实文件；
 * 无法解析时按违规处理（fail-closed），不得静默跳过。
 *
 * `http → crud` 只允许「路由文件 + 符号」闭集：同一 crud 模块在不同路由文件中
 * 未登记的符号仍属违规；namespace / default 导入与 re-export 无法静态确认符号，
 * 直接判违规。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { REPO_ROOT, toRepoPath, walk, writeTree } from "../helpers/repo-source";

type Layer =
  | "http"
  | "services"
  | "crud"
  | "core"
  | "utils"
  | "schemas"
  | "assembly"
  | "resources"
  | "shared"
  | "other";

interface Violation {
  /** 仓库根相对路径（统一 `/` 分隔） */
  file: string;
  specifier: string;
  rule: "layer" | "unresolved" | "http-crud-symbol" | "http-crud-shape" | "whitelist-unused";
  targetLayer?: Layer;
  symbol?: string;
  message: string;
}

/** 进程组装根：唯一允许跨层导入的文件（specs/server-crud-service-boundary.md 分层规则） */
const ASSEMBLY_FILES = new Set(["server/index.ts", "server/bootstrap.ts"]);

/**
 * `http → crud` 白名单：路由文件名 → 允许导入的 crud 符号。
 * 与实际导入集合逐项一致（验收标准 20）；白名单外符号、namespace/default
 * 导入与 re-export 一律违规。
 */
const CRUD_ROUTE_WHITELIST: Readonly<Record<string, ReadonlySet<string>>> = {
  "agent.ts": new Set([
    "createSession",
    "listSessions",
    "getSession",
    "renameSession",
    "deleteSession",
    "createMessage",
    "listMessages",
    "touchSession",
    "PersistedToolCall",
  ]),
  "assets.ts": new Set([
    "AssetOperationError",
    "getFolders",
    "createFolder",
    "getFolder",
    "updateFolder",
    "deleteFolder",
    "getAssets",
    "getAsset",
    "updateAsset",
    "deleteAsset",
    "deleteAssetsBatch",
    "deleteAssetsByFileKeys",
    "createAssetsBatch",
    "updateAssetsBatch",
    "listFileKeys",
    "getAssetLibrarySummary",
  ]),
  "auth.ts": new Set([
    "getUserByUsername",
    "getUserById",
    "createUser",
    "isUsernameTakenError",
    "touchLastLogin",
    "toPublicUser",
  ]),
  "canvas.ts": new Set(["getProjects", "createProject", "getProject", "deleteProject", "projectExists"]),
  "generate.ts": new Set(["createTask", "getTask", "getTaskTerminalByIds", "getProvider"]),
  "model-config.ts": new Set([
    "getProviders",
    "createProvider",
    "getProvider",
    "updateProvider",
    "deleteProvider",
    "addModel",
    "batchSetModels",
    "deleteModel",
    "updateModelCapability",
  ]),
  "models.ts": new Set(["getProvider"]),
};

/**
 * 分层允许集（闭集）：源层 → 允许导入的目标层，与 Spec「分层定义与依赖规则」
 * 和「叶子模块规则」逐项一致。未登记的目标层一律禁止（fail-closed）；
 * 新增层间依赖必须先改 Spec，再改这里。
 */
const ALLOWED_TARGETS: Readonly<Record<Layer, ReadonlySet<Layer>>> = {
  http: new Set<Layer>(["http", "services", "crud", "core", "schemas", "utils", "shared"]),
  services: new Set<Layer>(["services", "crud", "core", "schemas", "utils", "shared"]),
  crud: new Set<Layer>(["crud", "core", "schemas", "utils", "shared"]),
  core: new Set<Layer>(["core", "schemas", "utils", "shared"]),
  utils: new Set<Layer>(["utils", "core", "schemas", "shared"]),
  schemas: new Set<Layer>(["schemas", "shared"]),
  assembly: new Set<Layer>(["assembly", "http", "services", "crud", "core", "utils", "schemas", "resources", "shared"]),
  resources: new Set<Layer>(["resources"]),
  shared: new Set<Layer>(["shared"]),
  // 未归入任何层的 server 文件先按 fail-closed 处理：只能与同类文件互相引用
  other: new Set<Layer>(["other"]),
};

/** utils 只能使用 core 的纯工具：数据库、事务与外部 I/O 子树禁止（叶子模块规则） */
const UTILS_FORBIDDEN_CORE_PREFIXES = ["server/core/database/", "server/core/redis/", "server/core/http-client/"];

function layerOf(root: string, abs: string): Layer {
  const rel = toRepoPath(root, abs);
  if (ASSEMBLY_FILES.has(rel)) return "assembly";
  if (rel.startsWith("server/http/")) return "http";
  if (rel.startsWith("server/services/")) return "services";
  if (rel.startsWith("server/crud/")) return "crud";
  if (rel.startsWith("server/core/")) return "core";
  if (rel.startsWith("server/utils/")) return "utils";
  if (rel.startsWith("server/schemas/")) return "schemas";
  if (rel.startsWith("server/resources/")) return "resources";
  if (rel.startsWith("shared/")) return "shared";
  return "other";
}

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", "/index.ts", "/index.tsx", "/index.mts"];

function resolveFile(base: string): string | null {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ResolvedSpecifier {
  /** 仓库内可解析的文件；外部包为 null */
  abs: string | null;
  /** 是否应解析到仓库内部（`.`, `@server/*`, `@noxrea/shared*`） */
  internal: boolean;
}

function resolveSpecifier(root: string, fromFile: string, specifier: string): ResolvedSpecifier {
  if (specifier.startsWith("@server/")) {
    return { abs: resolveFile(path.join(root, "server", specifier.slice("@server/".length))), internal: true };
  }
  if (specifier === "@noxrea/shared") {
    return { abs: resolveFile(path.join(root, "shared/index")), internal: true };
  }
  if (specifier.startsWith("@noxrea/shared/")) {
    return { abs: resolveFile(path.join(root, "shared", specifier.slice("@noxrea/shared/".length))), internal: true };
  }
  if (specifier.startsWith(".")) {
    return { abs: resolveFile(path.resolve(path.dirname(fromFile), specifier)), internal: true };
  }
  return { abs: null, internal: false };
}

interface ImportRecord {
  specifier: string;
  /** 静态命名导入的符号；namespace/default/re-export/动态导入为 null（无法静态确认） */
  symbols: string[] | null;
  /** re-export 或动态 import：不是普通 import 声明 */
  forwarding: boolean;
}

function entityNameRoot(name: ts.EntityName): string {
  let current = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current.text;
}

function collectImports(sourceFile: ts.SourceFile): ImportRecord[] {
  const records: ImportRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      let symbols: string[] | null = null;
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        symbols = clause.namedBindings.elements.map((element) => (element.propertyName ?? element.name).text);
      }
      // namespace / default / 无绑定（副作用导入）都无法静态确认符号集合
      records.push({ specifier: node.moduleSpecifier.text, symbols, forwarding: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      records.push({ specifier: node.moduleSpecifier.text, symbols: null, forwarding: true });
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import("x")` / `import("x").Foo`：类型位置的模块引用
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
        records.push({
          specifier: arg.literal.text,
          symbols: node.qualifier === undefined ? null : [entityNameRoot(node.qualifier)],
          forwarding: false,
        });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const { expression } = node.moduleReference;
      if (ts.isStringLiteralLike(expression)) {
        records.push({ specifier: expression.text, symbols: null, forwarding: false });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        records.push({ specifier: arg.text, symbols: null, forwarding: true });
      } else {
        // 动态 import 的说明符不是字面量：无法静态解析，fail-closed
        records.push({ specifier: "<dynamic>", symbols: null, forwarding: true });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return records;
}

function collectViolations(root: string): Violation[] {
  const files: string[] = [];
  walk(path.join(root, "server"), files);
  walk(path.join(root, "shared"), files);

  const violations: Violation[] = [];
  /** 路由文件 → 实际从 crud 导入的符号（用于白名单逐项一致校验） */
  const usedCrudSymbols = new Map<string, Set<string>>();

  for (const abs of files) {
    const rel = toRepoPath(root, abs);
    const sourceLayer = layerOf(root, abs);
    const text = readFileSync(abs, "utf8");
    const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const routeName = path.basename(rel);
    const routeWhitelist = sourceLayer === "http" && rel.startsWith("server/http/routes/") ? CRUD_ROUTE_WHITELIST[routeName] : undefined;

    for (const record of collectImports(sourceFile)) {
      if (record.specifier === "<dynamic>") {
        violations.push({ file: rel, specifier: record.specifier, rule: "unresolved", message: "动态 import() 的说明符不是字符串字面量，无法静态校验" });
        continue;
      }

      const resolved = resolveSpecifier(root, abs, record.specifier);
      if (resolved.internal && resolved.abs === null) {
        violations.push({ file: rel, specifier: record.specifier, rule: "unresolved", message: "说明符无法解析到仓库内文件（fail-closed）" });
        continue;
      }
      if (resolved.abs === null) continue;

      const targetRel = toRepoPath(root, resolved.abs);
      const targetLayer = layerOf(root, resolved.abs);

      // 组装根唯一：除组装根自身外，任何模块都不得导入 server/index.ts / server/bootstrap.ts
      if (targetLayer === "assembly" && sourceLayer !== "assembly") {
        violations.push({ file: rel, specifier: record.specifier, rule: "layer", targetLayer, message: `${sourceLayer} 不得依赖组装根` });
        continue;
      }

      // 分层允许集闭包：未登记的目标层一律违规
      if (!ALLOWED_TARGETS[sourceLayer].has(targetLayer)) {
        const message = sourceLayer === "shared"
          ? `shared 不得依赖 server（${targetLayer}）`
          : `${sourceLayer} 不得依赖 ${targetLayer}`;
        violations.push({ file: rel, specifier: record.specifier, rule: "layer", targetLayer, message });
        continue;
      }

      // utils 使用 core 时只能取纯工具：数据库、事务与外部 I/O 子树单独拒绝
      if (
        sourceLayer === "utils"
        && targetLayer === "core"
        && UTILS_FORBIDDEN_CORE_PREFIXES.some((prefix) => targetRel.startsWith(prefix))
      ) {
        violations.push({ file: rel, specifier: record.specifier, rule: "layer", targetLayer, message: "utils 不得依赖 core 的数据库/事务/外部 I/O 模块" });
        continue;
      }

      if (targetLayer !== "crud" || sourceLayer !== "http") continue;

      // http → crud：只允许白名单路由文件里的命名导入
      if (routeWhitelist === undefined) {
        violations.push({ file: rel, specifier: record.specifier, rule: "http-crud-shape", message: "未登记的路由文件不得直接导入 crud" });
        continue;
      }
      if (record.symbols === null) {
        violations.push({ file: rel, specifier: record.specifier, rule: "http-crud-shape", message: "crud 只允许命名导入；namespace/default/re-export/动态导入无法静态确认符号" });
        continue;
      }
      const used = usedCrudSymbols.get(routeName) ?? new Set<string>();
      usedCrudSymbols.set(routeName, used);
      for (const symbol of record.symbols) {
        used.add(symbol);
        if (!routeWhitelist.has(symbol)) {
          violations.push({ file: rel, specifier: record.specifier, rule: "http-crud-symbol", symbol, message: `crud 符号 ${symbol} 未登记在白名单` });
        }
      }
    }
  }

  // 白名单与路由实际导入逐项一致：白名单内未使用的符号同样视为过期登记
  for (const [routeName, whitelist] of Object.entries(CRUD_ROUTE_WHITELIST)) {
    const routeAbs = path.join(root, "server/http/routes", routeName);
    if (!existsSync(routeAbs)) continue;
    const used = usedCrudSymbols.get(routeName) ?? new Set<string>();
    for (const symbol of whitelist) {
      if (!used.has(symbol)) {
        violations.push({ file: `server/http/routes/${routeName}`, specifier: "", rule: "whitelist-unused", symbol, message: `白名单符号 ${symbol} 未被路由使用` });
      }
    }
  }

  return violations;
}

function formatViolations(violations: Violation[]): string[] {
  return violations.map((violation) => `${violation.file} -> ${violation.specifier} [${violation.rule}] ${violation.message}`);
}

describe("架构边界：server 分层依赖", () => {
  it("server/ 与 shared/ 的静态与动态引用满足分层规则与路由白名单", () => {
    const violations = collectViolations(REPO_ROOT);
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("架构边界：检查器负例", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "noxrea-layer-boundaries-"));

  writeTree(fixtureRoot, {
    "server/crud/canvas.ts": "export function getProject(): void {}\nexport function updateProject(): void {}\n",
    "server/http/routes/canvas.ts": [
      'import { updateProject } from "@server/crud/canvas";',
      'import type { Nope } from "@server/crud/canvas";',
      'import * as crud from "@server/crud/canvas";',
      'export { getProject } from "@server/crud/canvas";',
      "void crud;",
      "void updateProject;",
    ].join("\n"),
    "server/crud/agent.ts": "export default function createSession(): void {}\n",
    "server/http/routes/agent.ts": 'import createSession from "@server/crud/agent";\nvoid createSession;\n',
    "server/http/server.ts": "export {};\n",
    "server/bootstrap.ts": "export function bootstrap(): void {}\n",
    "server/index.ts": 'import { bootstrap } from "@server/bootstrap";\nvoid bootstrap;\n',
    "server/services/http-consumer.ts": 'import "@server/http/server";\n',
    "server/services/bootstrap-consumer.ts": 'import { bootstrap } from "@server/bootstrap";\nvoid bootstrap;\n',
    "server/core/service-consumer.ts": 'import "@server/services/http-consumer";\n',
    "server/utils/crud-consumer.ts": 'import "@server/crud/canvas";\n',
    "server/resources/data.json": "{}\n",
    "server/crud/resources-consumer.ts": 'import data from "@server/resources/data.json";\nvoid data;\n',
    "server/core/database/client.ts": "export const prisma = {};\n",
    "server/core/logger.ts": "export const logger = {};\n",
    "server/utils/db-consumer.ts": 'import { prisma } from "@server/core/database/client";\nvoid prisma;\n',
    "server/misc.ts": 'import { logger } from "@server/core/logger";\nvoid logger;\n',
    "server/services/unresolved.ts": 'export async function load(): Promise<unknown> {\n  return import("@server/services/missing");\n}\n',
    "server/core/type-query.ts": 'export type Crud = typeof import("@server/crud/canvas");\n',
    "server/core/import-equals.ts": 'import crud = require("@server/crud/canvas");\nvoid crud;\n',
    "shared/server-consumer.ts": 'import "@server/core/service-consumer";\n',
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const violations = collectViolations(fixtureRoot);
  const has = (predicate: (violation: Violation) => boolean): boolean => violations.some(predicate);

  it("未登记符号与类型导入都会被判违规", () => {
    expect(has((v) => v.file === "server/http/routes/canvas.ts" && v.rule === "http-crud-symbol" && v.symbol === "updateProject")).toBe(true);
    expect(has((v) => v.file === "server/http/routes/canvas.ts" && v.rule === "http-crud-symbol" && v.symbol === "Nope")).toBe(true);
  });

  it("namespace 导入与 re-export 无法静态确认符号，直接判违规", () => {
    const shapeViolations = violations.filter((v) => v.file === "server/http/routes/canvas.ts" && v.rule === "http-crud-shape");
    expect(shapeViolations).toHaveLength(2);
  });

  it("default 导入无法静态确认符号，直接判违规", () => {
    expect(has((v) => v.file === "server/http/routes/agent.ts" && v.rule === "http-crud-shape")).toBe(true);
  });

  it("crud/services/core/utils/shared 与组装根的越界引用都会失败", () => {
    expect(has((v) => v.file === "server/services/http-consumer.ts" && v.rule === "layer" && v.targetLayer === "http")).toBe(true);
    expect(has((v) => v.file === "server/core/service-consumer.ts" && v.rule === "layer" && v.targetLayer === "services")).toBe(true);
    expect(has((v) => v.file === "server/utils/crud-consumer.ts" && v.rule === "layer" && v.targetLayer === "crud")).toBe(true);
    expect(has((v) => v.file === "shared/server-consumer.ts" && v.rule === "layer" && v.targetLayer === "core")).toBe(true);
    // 组装根自身可以互相导入（fixture 中的 server/index.ts），其它层导入组装根必须失败
    expect(has((v) => v.file === "server/services/bootstrap-consumer.ts" && v.rule === "layer" && v.targetLayer === "assembly")).toBe(true);
    expect(has((v) => v.file === "server/index.ts")).toBe(false);
  });

  it("允许集闭包覆盖原禁止表未登记的边（crud→resources、未分类文件）", () => {
    expect(has((v) => v.file === "server/crud/resources-consumer.ts" && v.rule === "layer" && v.targetLayer === "resources")).toBe(true);
    expect(has((v) => v.file === "server/misc.ts" && v.rule === "layer" && v.targetLayer === "core")).toBe(true);
  });

  it("utils 只能使用 core 的纯工具，数据库/事务/外部 I/O 子树直接违规", () => {
    expect(has((v) => v.file === "server/utils/db-consumer.ts" && v.rule === "layer" && v.targetLayer === "core")).toBe(true);
  });

  it("无法解析的动态 import() fail-closed", () => {
    expect(has((v) => v.file === "server/services/unresolved.ts" && v.rule === "unresolved")).toBe(true);
  });

  it("typeof import() 与 import x = require() 同样参与分层校验", () => {
    expect(has((v) => v.file === "server/core/type-query.ts" && v.rule === "layer" && v.targetLayer === "crud")).toBe(true);
    expect(has((v) => v.file === "server/core/import-equals.ts" && v.rule === "layer" && v.targetLayer === "crud")).toBe(true);
  });
});
