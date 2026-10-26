// @vitest-environment jsdom
/**
 * 标题中间截断：截断结果由共享 ResizeObserver 的尺寸回调写入（测量不再发生在
 * React 提交期）。这里用可控的 RO 替身驱动回调，验证超宽截断、放宽还原，
 * 以及未收到尺寸回调前始终显示原文。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NodeTitle from "@/features/canvas/nodes/NodeTitle";

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

const CHAR_WIDTH = 10;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  /** 模拟一次尺寸回调：所有被观察元素都按给定内容宽度上报 */
  emit(width: number) {
    const entries = [...this.targets].map(
      (target) => ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry
    );
    if (entries.length) {
      this.callback(entries, this as unknown as ResizeObserver);
    }
  }
}

function titleText(container: HTMLElement): string {
  return container.querySelector<HTMLElement>('span[style*="nowrap"]')?.textContent ?? "";
}

describe("NodeTitle 中间截断", () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    // canvas 量宽：每个字符固定 10px，结果可预期
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: text.length * CHAR_WIDTH }),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const title = "a-very-long-source-title-tail";

  it("尺寸回调前显示原文，超宽时中间截断并保留头尾", () => {
    const { container } = render(<NodeTitle nodeId="node-1" title={title} />);
    expect(titleText(container)).toBe(title);

    const observer = MockResizeObserver.instances.at(-1)!;
    act(() => observer.emit(100));

    const display = titleText(container);
    expect(display).toContain("…");
    expect(display.startsWith(title.slice(0, 2))).toBe(true);
    expect(display.endsWith(title.slice(-2))).toBe(true);
    expect(display.length).toBeLessThan(title.length);
  });

  it("宽度放宽后还原完整标题", () => {
    const { container } = render(<NodeTitle nodeId="node-2" title={title} />);
    const observer = MockResizeObserver.instances.at(-1)!;

    act(() => observer.emit(100));
    expect(titleText(container)).toContain("…");

    act(() => observer.emit(10_000));
    expect(titleText(container)).toBe(title);
  });

  it("极窄时只显示省略号", () => {
    const { container } = render(<NodeTitle nodeId="node-3" title={title} />);
    const observer = MockResizeObserver.instances.at(-1)!;

    act(() => observer.emit(5));
    expect(titleText(container)).toBe("…");
  });
});
