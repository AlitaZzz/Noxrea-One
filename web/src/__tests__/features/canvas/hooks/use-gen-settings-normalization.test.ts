// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { normalizeCanvasGenSettings } = vi.hoisted(() => ({
  normalizeCanvasGenSettings: vi.fn(),
}));

vi.mock("@/features/canvas/shared/gen-settings", () => ({ normalizeCanvasGenSettings }));

import { useGenSettingsNormalization } from "@/features/canvas/hooks/use-gen-settings-normalization";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useModelStore } from "@/lib/model-store";

/**
 * 画布级归一化的触发条件回归：连线选中态与连通关系共用 edges 数组，
 * 选中变化不能触发全画布扫描（否则每次点边都 O(节点数 × 连线数)），
 * 只有连通关系真正变化才需要重新收敛 refMode。
 */

function edge(id: string, source: string, target: string, selected = false) {
  return { id, source, target, selected };
}

afterEach(() => {
  cleanup();
  normalizeCanvasGenSettings.mockReset();
  useCanvasStore.setState({ edges: [] });
  useModelStore.setState({ providers: [], modelParamsCache: {} });
});

describe("useGenSettingsNormalization", () => {
  it("只在连线连通关系变化时重新归一化，选中态变化不触发", () => {
    useCanvasStore.setState({ edges: [edge("e1", "a", "b")] });

    renderHook(() => useGenSettingsNormalization());
    // 挂载时目录 effect 与拓扑 effect 各执行一次
    expect(normalizeCanvasGenSettings).toHaveBeenCalledWith({ placeholder: false });
    normalizeCanvasGenSettings.mockClear();

    // 仅选中态变化：edges 数组换新，连通关系不变
    act(() => {
      useCanvasStore.setState({ edges: [edge("e1", "a", "b", true)] });
    });
    expect(normalizeCanvasGenSettings).not.toHaveBeenCalled();

    // 连通关系变化：新增连线
    act(() => {
      useCanvasStore.setState({
        edges: [edge("e1", "a", "b", true), edge("e2", "b", "c")],
      });
    });
    expect(normalizeCanvasGenSettings).toHaveBeenCalledTimes(1);
    expect(normalizeCanvasGenSettings).toHaveBeenCalledWith({ placeholder: false });
  });
});
