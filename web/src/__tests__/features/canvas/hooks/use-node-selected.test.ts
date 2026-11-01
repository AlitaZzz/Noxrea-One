// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useMultiSelect,
  useNodeSelected,
  useNodeSelectionChange,
} from "@/features/canvas/hooks/use-node-selected";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

/**
 * 选中订阅口回归：节点主体不再因 selected prop 重渲染（见 memo-canvas-node），
 * 需要选中态的 UI/行为改为独立订阅。这里锁住两个契约：
 * - useNodeSelected 只在目标节点布尔翻转时重渲染，其他节点选中/无关状态不触发；
 * - useNodeSelectionChange 挂载不回调，只在真正翻转时回调最新函数。
 */

function node(id: string, selected = false): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x: 0, y: 0 },
    data: {},
    selected,
    style: { width: 120, height: 80 },
  } as unknown as AnyNode;
}

function setNodes(...nodes: AnyNode[]): void {
  useCanvasStore.setState({ nodes, edges: [] });
}

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ nodes: [], edges: [] });
});

describe("useNodeSelected", () => {
  it("只在目标节点选中态翻转时重渲染", () => {
    setNodes(node("a"), node("b"));
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useNodeSelected("a");
    });
    expect(result.current).toBe(false);
    expect(renders).toBe(1);

    // 其他节点选中：目标节点布尔不变，不重渲染
    act(() => setNodes(node("a"), node("b", true)));
    expect(result.current).toBe(false);
    expect(renders).toBe(1);

    // 无关状态变化：不重渲染
    act(() => useCanvasStore.setState({ minimapVisible: true }));
    expect(renders).toBe(1);

    // 目标节点选中：翻转一次、重渲染一次
    act(() => setNodes(node("a", true), node("b", true)));
    expect(result.current).toBe(true);
    expect(renders).toBe(2);

    // 已选中状态下节点列表被替换（拖动帧等）：布尔不变，不重渲染
    act(() => setNodes(node("a", true), node("b", true)));
    expect(renders).toBe(2);
  });
});

describe("useMultiSelect", () => {
  it("按选中节点数是否 ≥2 翻转", () => {
    setNodes(node("a", true), node("b"));
    const { result } = renderHook(() => useMultiSelect());
    expect(result.current).toBe(false);

    act(() => setNodes(node("a", true), node("b", true)));
    expect(result.current).toBe(true);

    act(() => setNodes(node("a"), node("b", true)));
    expect(result.current).toBe(false);
  });
});

describe("useNodeSelectionChange", () => {
  it("挂载不回调，只在翻转时回调最新函数", () => {
    setNodes(node("a"), node("b"));
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onChange }: { onChange: (selected: boolean) => void }) =>
        useNodeSelectionChange("a", onChange),
      { initialProps: { onChange: first } },
    );
    expect(first).not.toHaveBeenCalled();

    // 其他节点选中：目标节点未翻转，不回调
    act(() => setNodes(node("a"), node("b", true)));
    expect(first).not.toHaveBeenCalled();

    act(() => setNodes(node("a", true), node("b", true)));
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenLastCalledWith(true);

    rerender({ onChange: second });
    act(() => setNodes(node("a"), node("b", true)));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith(false);
  });
});
