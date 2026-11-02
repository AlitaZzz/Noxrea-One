// @vitest-environment jsdom
/**
 * 提示词字形预热回归：
 * - 悬停生成节点时按编辑器计算字体预热提示词文本；
 * - 非生成节点 / 空提示词不触发；
 * - 已完成文本缓存，重复悬停不重复测量；
 * - 悬停目标变化（含非生成节点、空提示词、已缓存文本）取消上一段未完成的预热。
 *
 * 真实收益（首次 layout 降低）在浏览器中实测，jsdom 只能覆盖触发与调度行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROMPT_EDITOR_CLASS } from "@/features/canvas/shared/prompt-editor";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

const measureText = vi.fn((text: string) => ({ width: text.length * 10 }) as TextMetrics);
const context = { font: "", measureText } as unknown as CanvasRenderingContext2D;

async function loadModule() {
  vi.resetModules();
  return import("@/features/canvas/shared/prompt-shaping-prewarm");
}

function node(type: string, prompt: string): AnyNode {
  return {
    id: "node-1",
    type,
    position: { x: 0, y: 0 },
    data: { genSettings: { prompt } },
  } as unknown as AnyNode;
}

function measuredText(): string {
  return measureText.mock.calls.map(([text]) => String(text)).join("");
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom 不加载项目 CSS，按 `.mention-editable` 的真实计算值提供字体样式
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
    if (element.classList.contains(PROMPT_EDITOR_CLASS)) {
      return {
        fontStyle: "normal",
        fontWeight: "400",
        fontSize: "13px",
        fontFamily: "Test Sans",
      } as CSSStyleDeclaration;
    }
    return originalGetComputedStyle(element);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as never,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  measureText.mockClear();
  context.font = "";
});

describe("prewarmPromptForNode", () => {
  it("按编辑器计算字体分片测量生成节点提示词", async () => {
    const { prewarmPromptForNode } = await loadModule();
    const text = "汉".repeat(100);

    prewarmPromptForNode(node(NODE_TYPE.VIDEO, text));
    await vi.runAllTimersAsync();

    expect(measuredText()).toBe(text);
    const chunks = measureText.mock.calls.map(([chunk]) => String(chunk));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length < text.length)).toBe(true);
    expect(context.font).toContain("13px");
    expect(context.font).toContain("Test Sans");
  });

  it("非生成节点不预热", async () => {
    const { prewarmPromptForNode } = await loadModule();

    prewarmPromptForNode(node(NODE_TYPE.AUDIO, "不应测量"));
    await vi.runAllTimersAsync();

    expect(measureText).not.toHaveBeenCalled();
  });

  it("空提示词不预热", async () => {
    const { prewarmPromptForNode } = await loadModule();

    prewarmPromptForNode(node(NODE_TYPE.IMAGE, "   \n  "));
    await vi.runAllTimersAsync();

    expect(measureText).not.toHaveBeenCalled();
  });

  it("已完成文本重复悬停不重复测量", async () => {
    const { prewarmPromptForNode } = await loadModule();
    const target = node(NODE_TYPE.TEXT, "重复文本");

    prewarmPromptForNode(target);
    await vi.runAllTimersAsync();
    const firstRunCalls = measureText.mock.calls.length;
    expect(firstRunCalls).toBeGreaterThan(0);

    prewarmPromptForNode(target);
    await vi.runAllTimersAsync();

    expect(measureText).toHaveBeenCalledTimes(firstRunCalls);
  });

  it("新悬停目标取消上一段未完成的预热", async () => {
    const { prewarmPromptForNode } = await loadModule();

    prewarmPromptForNode(node(NODE_TYPE.VIDEO, "第一段文本"));
    prewarmPromptForNode(node(NODE_TYPE.VIDEO, "第二段文本"));
    await vi.runAllTimersAsync();

    expect(measuredText()).toBe("第二段文本");
  });

  it("悬停非生成节点取消上一段未完成的预热", async () => {
    const { prewarmPromptForNode } = await loadModule();

    prewarmPromptForNode(node(NODE_TYPE.VIDEO, "上一段文本"));
    prewarmPromptForNode(node(NODE_TYPE.AUDIO, "非生成节点"));
    await vi.runAllTimersAsync();

    expect(measureText).not.toHaveBeenCalled();
  });

  it("悬停空提示词取消上一段未完成的预热", async () => {
    const { prewarmPromptForNode } = await loadModule();

    prewarmPromptForNode(node(NODE_TYPE.VIDEO, "上一段文本"));
    prewarmPromptForNode(node(NODE_TYPE.IMAGE, "   \n  "));
    await vi.runAllTimersAsync();

    expect(measureText).not.toHaveBeenCalled();
  });

  it("悬停已缓存文本取消上一段未完成的预热", async () => {
    const { prewarmPromptForNode } = await loadModule();
    const cached = node(NODE_TYPE.IMAGE, "已缓存文本");

    prewarmPromptForNode(cached);
    await vi.runAllTimersAsync();
    measureText.mockClear();

    prewarmPromptForNode(node(NODE_TYPE.VIDEO, "新的长文本"));
    prewarmPromptForNode(cached);
    await vi.runAllTimersAsync();

    expect(measureText).not.toHaveBeenCalled();
  });
});
