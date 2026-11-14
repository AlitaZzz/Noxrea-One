// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { ReactFlow } from "@xyflow/react";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { CanvasDotGrid } from "@/features/canvas/controls/CanvasDotGrid";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const globalsCss = readFileSync(resolve(TEST_DIR, "../../../../styles/globals.css"), "utf8");
const canvasSurfaceSource = readFileSync(
  resolve(TEST_DIR, "../../../../features/canvas/root/CanvasSurface.tsx"),
  "utf8"
);
/** 去掉注释后再断言，避免注释里的示例文本单独满足契约。 */
const globalsCssCode = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 按源码顺序合并 :root 与 .dark 规则，返回指定主题实际生效的 token。
 * 后置声明覆盖前置声明；组合选择器（如 `:root, .dark`）按分支生效，
 * 因此同时覆盖注释、级联与选择器改写三类假阳性。
 */
function effectiveCanvasTokens(theme: "light" | "dark"): Record<string, string> {
  const tokens: Record<string, string> = {};
  const rulePattern = /(?:^|\n)\s*([^{}\n][^{}]*?)\s*\{([^{}]*)\}/g;
  for (const match of globalsCssCode.matchAll(rulePattern)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    const applies =
      selectors.includes(":root") || (theme === "dark" && selectors.includes(".dark"));
    if (!applies) continue;
    for (const declaration of match[2].matchAll(
      /(--canvas-(?:bg|dot-color))\s*:\s*([^;]+);/g
    )) {
      tokens[declaration[1]] = declaration[2].trim();
    }
  }
  return tokens;
}

/** 找到 JSX 元素的表达式属性（如 `<ReactFlow style={RF_STYLE}>` 的 style）。 */
function jsxAttributeExpression(
  sourceFile: ts.SourceFile,
  tagName: string,
  attributeName: string
): ts.Expression | null {
  let expression: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sourceFile) === tagName) {
        for (const property of node.attributes.properties) {
          if (
            ts.isJsxAttribute(property) &&
            property.name.getText(sourceFile) === attributeName &&
            property.initializer &&
            ts.isJsxExpression(property.initializer) &&
            property.initializer.expression
          ) {
            expression = property.initializer.expression;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expression;
}

/** 找到变量声明中的对象字面量（如 `const RF_STYLE = {...} as CSSProperties`）。 */
function variableObjectLiteral(
  sourceFile: ts.SourceFile,
  name: string
): ts.ObjectLiteralExpression | null {
  let literal: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      let initializer = node.initializer;
      while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (ts.isObjectLiteralExpression(initializer)) literal = initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literal;
}

afterEach(cleanup);

function renderAtZoom(zoom: number) {
  return render(
    <ReactFlow
      nodes={[]}
      edges={[]}
      defaultViewport={{ x: 0, y: 0, zoom }}
      minZoom={0.1}
      maxZoom={5}
    >
      <CanvasDotGrid />
    </ReactFlow>
  );
}

function getPattern(container: HTMLElement) {
  const svg = container.querySelector<SVGSVGElement>(".react-flow__background");
  expect(svg).not.toBeNull();
  const pattern = svg!.querySelector("pattern");
  expect(pattern).not.toBeNull();
  return { svg: svg!, pattern: pattern! };
}

describe("CanvasDotGrid", () => {
  it("matches the Jimeng lattice geometry and keeps dots screen-constant", () => {
    const { container } = renderAtZoom(0.5);
    const { svg, pattern } = getPattern(container);
    const circle = pattern.querySelector("circle")!;

    // 18 世界像素 × 0.5 缩放 = 9px 屏幕间距
    expect(Number(pattern.getAttribute("width"))).toBeCloseTo(9, 5);
    expect(Number(pattern.getAttribute("height"))).toBeCloseTo(9, 5);
    // 1 屏幕像素直径 = 0.5px 半径，不随缩放变化
    expect(Number(circle.getAttribute("r"))).toBeCloseTo(0.5, 5);
    expect(svg.style.getPropertyValue("--xy-background-pattern-color-props")).toBe(
      "var(--canvas-dot-color)"
    );
  });

  it("keeps the 0.5px screen radius at high zoom", () => {
    const { container } = renderAtZoom(2);
    const { pattern } = getPattern(container);

    expect(Number(pattern.getAttribute("width"))).toBeCloseTo(36, 5);
    expect(
      Number(pattern.querySelector("circle")!.getAttribute("r"))
    ).toBeCloseTo(0.5, 5);
  });

  it("hides the lattice below the Jimeng LOD threshold (18 × zoom < 8)", () => {
    const { container } = renderAtZoom(0.44);
    expect(container.querySelector(".react-flow__background")).toBeNull();
  });

  it("renders the lattice at the Jimeng LOD threshold", () => {
    const { container } = renderAtZoom(0.45);
    expect(container.querySelector(".react-flow__background")).not.toBeNull();
  });
});

/**
 * 几何与 LOD 已由渲染断言锁定；颜色契约还必须钉住 CSS token 与 React Flow
 * 根节点的底色注入，防止组件 prop、token 或底色映射任一处单独漂移。
 */
describe("CanvasDotGrid 颜色与底色契约", () => {
  it("明暗主题使用固定的画布底色与点阵色 token", () => {
    expect(effectiveCanvasTokens("light")).toEqual({
      "--canvas-bg": "#f5f5f5",
      "--canvas-dot-color": "rgb(115 115 115 / 45%)",
    });
    expect(effectiveCanvasTokens("dark")).toEqual({
      "--canvas-bg": "#0d0d0d",
      "--canvas-dot-color": "rgb(255 255 255 / 20%)",
    });
  });

  it("RF_STYLE 定义画布底色并实际传给 ReactFlow 根节点", () => {
    const sourceFile = ts.createSourceFile(
      "CanvasSurface.tsx",
      canvasSurfaceSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    // 应用点：必须是 <ReactFlow style={RF_STYLE}>，不能是未被使用的定义或内联覆盖
    const styleExpression = jsxAttributeExpression(sourceFile, "ReactFlow", "style");
    expect(styleExpression).not.toBeNull();
    expect(ts.isIdentifier(styleExpression!)).toBe(true);
    expect((styleExpression as ts.Identifier).text).toBe("RF_STYLE");

    // 定义点：底色映射必须读取 --canvas-bg，且只声明一次（重复声明以最后一条生效）
    const rfStyle = variableObjectLiteral(sourceFile, "RF_STYLE");
    expect(rfStyle).not.toBeNull();
    const backgroundProperties = (rfStyle as ts.ObjectLiteralExpression).properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        (ts.isStringLiteral(property.name)
          ? property.name.text
          : property.name.getText(sourceFile)) === "--xy-background-color"
    );
    expect(backgroundProperties).toHaveLength(1);
    expect(
      backgroundProperties[0].initializer.getText(sourceFile).replace(/["']/g, "")
    ).toBe("var(--canvas-bg)");
  });
});
