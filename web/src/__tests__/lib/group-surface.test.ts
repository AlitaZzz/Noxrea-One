import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getGroupSurfaceBackground,GROUP_COLORS } from "@/lib/constants";

/** 每个色板的最终背景表达式；字面量断言防止在 helper 内部静默改色/改透明度。 */
const EXPECTED_BACKGROUNDS: Record<string, string> = {
  default: "var(--canvas-group-bg)",
  brown: "color-mix(in srgb, #96643c 16%, var(--canvas-group-bg))",
  blue: "color-mix(in srgb, #1677ff 16%, var(--canvas-group-bg))",
  green: "color-mix(in srgb, #34c759 16%, var(--canvas-group-bg))",
  yellow: "color-mix(in srgb, #fadb14 16%, var(--canvas-group-bg))",
  orange: "color-mix(in srgb, #ff9500 16%, var(--canvas-group-bg))",
  red: "color-mix(in srgb, #ff3b30 16%, var(--canvas-group-bg))",
  purple: "color-mix(in srgb, #722ed1 16%, var(--canvas-group-bg))",
  pink: "color-mix(in srgb, #eb2f96 16%, var(--canvas-group-bg))",
  cyan: "color-mix(in srgb, #30d5c8 16%, var(--canvas-group-bg))",
};

const globalsCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/globals.css"),
  "utf8",
);

function cssBlock(selector: string): string {
  const match = globalsCss.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

/** 从行首精确匹配规则，避免前缀选择器（如拖线态）被当成普通规则命中。 */
function cssRule(selector: string): string {
  const match = globalsCss.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

/**
 * 组节点表面必须不透明（对齐即梦 canvas-node-background-default）：
 * 默认组只返回不透明组底色，彩色组在不透明底色上按 16% 叠加色相。
 */
describe("getGroupSurfaceBackground", () => {
  it("默认与未知配色使用不透明组底色", () => {
    expect(getGroupSurfaceBackground()).toBe("var(--canvas-group-bg)");
    expect(getGroupSurfaceBackground("default")).toBe("var(--canvas-group-bg)");
    expect(getGroupSurfaceBackground("missing")).toBe("var(--canvas-group-bg)");
  });

  it("每个色板生成固定的不透明表面表达式", () => {
    for (const [key, expected] of Object.entries(EXPECTED_BACKGROUNDS)) {
      expect(getGroupSurfaceBackground(key)).toBe(expected);
    }
  });

  it("除 default 外的色板都提供叠色", () => {
    const colored = Object.entries(GROUP_COLORS).filter(([key]) => key !== "default");
    expect(colored).toHaveLength(9);
    expect(colored.every(([, preset]) => Boolean(preset.tint))).toBe(true);
  });
});

/**
 * 字符串单测无法证明「不透明」：不透明度实际由 globals.css 的 token 与选择外框
 * 规则决定。这里读取样式源文件钉住契约，防止把 token 改成半透明、或让选择外框
 * 重新复用不透明的组表面。
 */
describe("组表面与选择外框的 CSS 契约", () => {
  it("组底色在明暗主题中都是不透明 6 位 hex", () => {
    expect(cssBlock(":root")).toContain("--canvas-group-bg: #ededed;");
    expect(cssBlock("\\.dark")).toContain("--canvas-group-bg: #161616;");
    expect(cssBlock(":root")).toMatch(/--canvas-group-bg:\s*#[0-9a-f]{6};/);
    expect(cssBlock("\\.dark")).toMatch(/--canvas-group-bg:\s*#[0-9a-f]{6};/);
  });

  it("选择外框使用独立的半透明 token，不复用不透明组表面", () => {
    expect(cssBlock(":root, \\.dark")).toContain(
      "--selection-frame-bg: rgb(255 255 255 / 4%);"
    );

    const rules = [...globalsCss.matchAll(/\.react-flow__nodesselection-rect\s*\{([\s\S]*?)\}/g)]
      .map((match) => match[1]);
    expect(
      rules.some((rule) => rule.includes("background: var(--selection-frame-bg) !important;"))
    ).toBe(true);
    expect(
      rules.every((rule) => !rule.includes("background: var(--canvas-group-bg)"))
    ).toBe(true);
  });

  it("拖线期间只把组背景降到 20%，标题与描边不参与", () => {
    expect(cssRule("\\.node-body\\.canvas-group-surface")).toContain(
      "background: var(--group-surface);"
    );

    const connecting = cssRule(
      "\\.react-flow\\[data-connecting\\] \\.node-body\\.canvas-group-surface"
    );
    expect(connecting).toContain(
      "background: color-mix(in srgb, var(--group-surface) 20%, transparent);"
    );
    // 用元素 opacity 会连描边一起变淡；必须只改背景
    expect(connecting).not.toContain("opacity:");
  });
});
