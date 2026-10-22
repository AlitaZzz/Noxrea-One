/**
 * Web 侧「持久化引用字段不落展示 URL」的源码断言（specs/storage-reference-key-unification.md 验收标准）。
 *
 * 持久化引用字段（节点 data.src、导演镜头 ref、multiResultKeys / fileKey / ref*
 * 等）的值域是存储 key 或外部 URL；托管展示 URL 只能在渲染期派生。本测试用
 * TypeScript AST 扫描源码锁定该不变量——AST 天然忽略注释与字符串字面量，函数 /
 * 生成器 / 方法定义不是 CallExpression，不会像文本扫描那样把定义计入调用点：
 * 1. 节点创建调用（`create*Node[FromRef]`）的引用实参不来自 URL 表达式；
 * 2. 持久化引用字段（对象字面量与 `data.<field>` 赋值）不来自 URL 表达式；
 * 3. 编辑信封不按 `{ url }` 声明，onSuccess 不以 `url` 为形参（历史回归形态）；
 * 4. 上传写入层不引用任何 URL 派生 helper 或托管路径。
 * 调用点计数基线防止扫描面静默失效（helper / 工厂更名后计数归零会直接失败）。
 * 静态扫描只跟踪一层 `const nd = node.data` 别名，更深层数据别名与 helper 别名等
 * 间接形态不覆盖；按路径回归测试（AudioNode / VideoNode 的客户端与服务端兜底
 * 用例）是这一断言的运行期补充，不以扫描替代。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.join(fileURLToPath(new URL("../../../", import.meta.url)), "src");
const SKIP = new Set(["__tests__", "node_modules", ".next"]);
const UPLOAD_DIR = path.join(SRC, "features", "canvas", "upload");
const UPLOAD_PREFIX = path.relative(SRC, UPLOAD_DIR) + path.sep;
/** 生产代码中节点创建调用点基线：新增 / 删除调用点时同步更新（扫描面自检） */
const NODE_CREATION_CALLS = 23;

/** 托管访问 URL 的派生入口：出现在持久化引用字段的右值里即越界 */
const URL_HELPERS = new Set([
  "buildManagedFileUrl",
  "fileRefUrl",
  "getManagedFilePathname",
  "managedFileUrl",
  "resolveFileUrl",
  "withManagedFileWidth",
]);
const MANAGED_FILE_PATH_LITERAL = "/api/files/";
/** 持久化引用字段（specs/storage-reference-key-unification.md 值域约定） */
const REF_FIELDS = new Set([
  "avatarKey",
  "coverKey",
  "fileKey",
  "fileKeys",
  "multiResultKeys",
  "ref",
  "refAudios",
  "refImages",
  "refVideos",
  "resultKeys",
  "src",
]);
const NODE_FACTORY = /^create(?:Image|Audio|Video)Node(?:FromRef)?$/;

/** URL 命名词：url / rawUrl / videoURL / audio_url；按词边界判定，无需动词例外。 */
function isUrlName(name: string): boolean {
  return name === "url" || /(?:Url|URL)$/.test(name) || /_url$/.test(name);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? walk(full)
      : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

function propertyNameOf(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** 表达式是否来自渲染期 URL：`.url` / URL 命名词 / 托管 URL 派生调用 / 托管路径字面量 */
function isUrlDerived(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return isUrlName(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "url" || isUrlDerived(expression.expression);
  }
  if (ts.isElementAccessExpression(expression)) {
    return (
      (ts.isStringLiteralLike(expression.argumentExpression) &&
        expression.argumentExpression.text === "url") ||
      isUrlDerived(expression.expression) ||
      isUrlDerived(expression.argumentExpression)
    );
  }
  if (ts.isCallExpression(expression)) {
    const name = calleeName(expression.expression);
    // 已知托管 URL helper，或按命名约定返回 URL 的函数（toFileUrl 等）
    return (
      URL_HELPERS.has(name ?? "") ||
      (!!name && isUrlName(name)) ||
      expression.arguments.some(isUrlDerived)
    );
  }
  if (ts.isStringLiteralLike(expression)) {
    return expression.text.includes(MANAGED_FILE_PATH_LITERAL);
  }
  if (ts.isTemplateExpression(expression)) {
    return (
      expression.head.text.includes(MANAGED_FILE_PATH_LITERAL) ||
      expression.templateSpans.some(
        (span) =>
          span.literal.text.includes(MANAGED_FILE_PATH_LITERAL) || isUrlDerived(span.expression),
      )
    );
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return isUrlDerived(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return isUrlDerived(expression.whenTrue) || isUrlDerived(expression.whenFalse);
  }
  if (ts.isBinaryExpression(expression)) {
    return isUrlDerived(expression.left) || isUrlDerived(expression.right);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(isUrlDerived);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some(
      (property) => ts.isPropertyAssignment(property) && isUrlDerived(property.initializer),
    );
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return !ts.isBlock(expression.body) && isUrlDerived(expression.body);
  }
  return false;
}

/** 表达式是否指向节点数据对象（`node.data` 或已知的 `const nd = node.data` 别名） */
function isNodeDataExpression(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  return (
    (ts.isIdentifier(expression) && aliases.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === "data")
  );
}

/** 赋值左侧是否节点数据上的持久化引用字段（`node.data.src` / `data["src"]` 等） */
function isDataRefAccess(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const base = ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
  if (!base || !isNodeDataExpression(base, aliases)) return false;
  if (ts.isPropertyAccessExpression(expression)) return REF_FIELDS.has(expression.name.text);
  const name = ts.isElementAccessExpression(expression) ? expression.argumentExpression : undefined;
  return !!name && ts.isStringLiteralLike(name) && REF_FIELDS.has(name.text);
}

/** onSuccess 回调是否以 url 为第一个形参（历史回归形态） */
function hasUrlFirstParam(expression: ts.Expression): boolean {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const [first] = expression.parameters;
  if (!first) return false;
  if (ts.isIdentifier(first.name)) return first.name.text === "url";
  return (
    ts.isObjectBindingPattern(first.name) &&
    first.name.elements.some((element) => ts.isIdentifier(element.name) && element.name.text === "url")
  );
}

interface ScanResult {
  /** 节点创建调用点数量（定义不是 CallExpression，天然不计入） */
  nodeFactoryCalls: number;
  /** 节点创建调用引用实参为 URL 表达式 */
  refArgOffenses: string[];
  /** 持久化引用字段写入为 URL 表达式 */
  refWriteOffenses: string[];
  /** 编辑信封按 { url } 声明 */
  envelopeUrlDeclarations: string[];
  /** onSuccess 以 url 为形参 */
  onSuccessUrlParams: string[];
  /** 上传层引用的 URL 派生 token */
  urlTokens: string[];
}

function scanSource(fileName: string, source: string): ScanResult {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node) =>
    `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
  const result: ScanResult = {
    nodeFactoryCalls: 0,
    refArgOffenses: [],
    refWriteOffenses: [],
    envelopeUrlDeclarations: [],
    onSuccessUrlParams: [],
    urlTokens: [],
  };
  /** 节点数据对象的一层别名（`const nd = node.data`）；直接以 data 命名的变量天然在内 */
  const dataAliases = new Set(["data"]);

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isNodeDataExpression(node.initializer, dataAliases)
    ) {
      dataAliases.add(node.name.text);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      NODE_FACTORY.test(node.expression.text)
    ) {
      result.nodeFactoryCalls += 1;
      // 工厂签名第 2 参是引用值（key / 外部 URL）；URL 表达式不得进入持久化值域
      const ref = node.arguments[1];
      if (ref && isUrlDerived(ref)) result.refArgOffenses.push(`${at(node)} ${ref.getText(sourceFile)}`);
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyNameOf(node.name);
      if (name && REF_FIELDS.has(name) && isUrlDerived(node.initializer)) {
        result.refWriteOffenses.push(`${at(node)} ${name}: ${node.initializer.getText(sourceFile)}`);
      }
      if (name === "onSuccess" && hasUrlFirstParam(node.initializer)) {
        result.onSuccessUrlParams.push(at(node));
      }
    }

    // 节点数据字段赋值：`node.data.src = …` / `const data = node.data; data.src = …`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isDataRefAccess(node.left, dataAliases) &&
      isUrlDerived(node.right)
    ) {
      result.refWriteOffenses.push(
        `${at(node)} ${node.left.getText(sourceFile)} = ${node.right.getText(sourceFile)}`,
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "readEditEnvelope"
    ) {
      const typeArg = node.typeArguments?.[0];
      if (
        typeArg &&
        ts.isTypeLiteralNode(typeArg) &&
        typeArg.members.some(
          (member) => ts.isPropertySignature(member) && propertyNameOf(member.name) === "url",
        )
      ) {
        result.envelopeUrlDeclarations.push(at(node));
      }
    }

    if (ts.isIdentifier(node) && URL_HELPERS.has(node.text)) result.urlTokens.push(node.text);
    if (ts.isStringLiteralLike(node) && node.text.includes(MANAGED_FILE_PATH_LITERAL)) {
      result.urlTokens.push(node.text);
    }
    if (ts.isIdentifier(node) && node.text === "MANAGED_FILE_PATH") result.urlTokens.push(node.text);

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return result;
}

const files = walk(SRC);
const scans = files.map((file) => ({
  file: path.relative(SRC, file),
  result: scanSource(path.relative(SRC, file), readFileSync(file, "utf8")),
}));

describe("Web 存储 key 写入契约（持久化引用字段不落展示 URL）", () => {
  it("扫描器自检：注释与定义不计入，历史回归形态必命中", () => {
    const sample = [
      "function createVideoNodeFromRef(id: string, ref: string) {}",
      "function* createImageNode(position: { x: number; y: number }) {}",
      "class Factory { createAudioNode(position: { x: number; y: number }) {} }",
      "// createVideoNodeFromRef(id, video.url);",
      "/* node.data.src = result.url; */",
      'const ok = createAudioNode({ x: 0, y: 0 }, "1/ab/abc.mp3");',
      "const bad = createVideoNodeFromRef(id, video.url, 1, 1, label, store);",
      "const node = { data: { src: fileRefUrl(key) } };",
      "node.data.src = managedFileUrl(key);",
      "node.data.ref = result.url;",
      'node.data["src"] = fileRefUrl(key);',
      "const nd = node.data;",
      "nd.src = fileRefUrl(key);",
      "const templated = { data: { src: `/api/files/${key}` } };",
      "const named = { data: { src: toFileUrl(key) } };",
      "const keys = { multiResultKeys: rawKeys.map((key) => fileRefUrl(key)) };",
      "const envelope = readEditEnvelope<{ url: string }>(res, signal, ctx);",
      "useMediaEditTask({ onSuccess: (url) => createNode(url) });",
      "useMediaEditTask({ onSuccess: async ({ url }) => createNode(url) });",
      "// fileRefUrl(key) in a comment is not a token",
    ].join("\n");
    const result = scanSource("<self-check>.tsx", sample);

    // 两个真实调用；函数 / 生成器 / 方法定义与注释都不计入
    expect(result.nodeFactoryCalls).toBe(2);
    expect(result.refArgOffenses).toHaveLength(1);
    expect(result.refArgOffenses[0]).toContain("video.url");

    expect(result.refWriteOffenses).toHaveLength(8);
    expect(result.refWriteOffenses.join("\n")).toContain("fileRefUrl(key)");
    expect(result.refWriteOffenses.join("\n")).toContain("managedFileUrl(key)");
    expect(result.refWriteOffenses.join("\n")).toContain("result.url");
    expect(result.refWriteOffenses.join("\n")).toContain("/api/files/");
    expect(result.refWriteOffenses.join("\n")).toContain("nd.src");
    expect(result.refWriteOffenses.join("\n")).toContain("multiResultKeys");

    expect(result.envelopeUrlDeclarations).toHaveLength(1);
    expect(result.onSuccessUrlParams).toHaveLength(2);
    // 注释里的 helper 不产生 token，代码中的 helper 产生
    expect(result.urlTokens).toEqual([
      "fileRefUrl",
      "managedFileUrl",
      "fileRefUrl",
      "fileRefUrl",
      "fileRefUrl",
    ]);
  });

  it("节点创建调用的引用实参不来自 URL 表达式", () => {
    const calls = scans.reduce((total, scan) => total + scan.result.nodeFactoryCalls, 0);
    // 扫描面自检：helper / 工厂更名或扫描器失明时在这里失败，而不是静默零命中
    expect(calls).toBe(NODE_CREATION_CALLS);
    expect(scans.flatMap((scan) => scan.result.refArgOffenses)).toEqual([]);
  });

  it("持久化引用字段写入不来自 URL 表达式", () => {
    expect(scans.flatMap((scan) => scan.result.refWriteOffenses)).toEqual([]);
  });

  it("编辑产物投影不按展示 URL 声明", () => {
    expect(scans.flatMap((scan) => scan.result.envelopeUrlDeclarations)).toEqual([]);
    expect(scans.flatMap((scan) => scan.result.onSuccessUrlParams)).toEqual([]);
  });

  it("上传写入层不引用 URL 派生 helper 或托管路径", () => {
    const uploadScans = scans.filter((scan) => scan.file.startsWith(UPLOAD_PREFIX));
    expect(uploadScans.length).toBeGreaterThan(0);
    for (const scan of uploadScans) {
      expect(scan.result.urlTokens, scan.file).toEqual([]);
    }
  });
});
