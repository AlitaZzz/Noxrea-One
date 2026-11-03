// @vitest-environment jsdom
/**
 * 画布根光标门控属性回归：
 * `data-connecting` 只在拖线期间存在；选中态切换（idle ↔ box-selected）
 * 不得改变它，否则全后代光标规则会让整棵画布子树重算样式。
 *
 * 工具条可见性回归：框选提交（box-selected）后工具条必须出现，但生成面板
 * 仍按框选语义让位；框选手势与拖动期间工具条隐藏。
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  canvasRootInteractionAttrs,
  useCanvasInteraction,
} from "@/features/canvas/hooks/use-canvas-interaction";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ interaction: { mode: "idle" } });
});

describe("canvasRootInteractionAttrs", () => {
  it("拖线期间写 data-connecting", () => {
    expect(canvasRootInteractionAttrs("connecting")).toEqual({
      "data-interaction": "connecting",
      "data-connecting": "true",
    });
  });

  it("其余交互状态不写 data-connecting", () => {
    for (const mode of ["idle", "box-selecting", "box-selected", "dragging-nodes"] as const) {
      expect(canvasRootInteractionAttrs(mode)).toEqual({
        "data-interaction": mode,
        "data-connecting": undefined,
      });
    }
  });
});

describe("useCanvasInteraction：工具条可见性", () => {
  it("框选提交后显示工具条，但生成面板仍让位", () => {
    useCanvasStore.setState({ interaction: { mode: "box-selected" } });

    const { result } = renderHook(() => useCanvasInteraction());

    expect(result.current.showSelectionToolbars).toBe(true);
    expect(result.current.showSelectionChrome).toBe(false);
  });

  it("框选手势进行中隐藏工具条", () => {
    useCanvasStore.setState({ interaction: { mode: "box-selecting" } });

    const { result } = renderHook(() => useCanvasInteraction());

    expect(result.current.showSelectionToolbars).toBe(false);
  });

  it("点击选中（idle）时工具条与生成面板都显示", () => {
    useCanvasStore.setState({ interaction: { mode: "idle" } });

    const { result } = renderHook(() => useCanvasInteraction());

    expect(result.current.showSelectionToolbars).toBe(true);
    expect(result.current.showSelectionChrome).toBe(true);
  });
});
