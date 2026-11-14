/**
 * React Flow 事件处理器的过期闭包回归测试（驱动生产 hook）。
 *
 * 建模背景：React Flow 在同一渲染帧内可能连续派发多次变更（选中 + 位置/尺寸）。
 * 生产 hook（use-canvas-node-changes / use-canvas-edge-changes）必须始终以
 * store 实时状态为基底应用变更；若以渲染期闭包中的 nodes/edges 为基底，第二次
 * 变更会覆盖第一次的选中写入（拆分前 CanvasSurface 的五个 handler 即此缺陷）。
 *
 * 本测试不再手工重演 applyNodeChanges 语义，而是渲染真实 hook 并调用其返回的
 * handler，断言同帧变更全部落地。
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Edge, EdgeChange, NodeChange } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DragPreviewSession } from "@/features/canvas/drag/drag-preview-session";
import { useCanvasEdgeChanges } from "@/features/canvas/hooks/use-canvas-edge-changes";
import { useCanvasNodeChanges } from "@/features/canvas/hooks/use-canvas-node-changes";
import { saveManager } from "@/features/canvas/persistence/save-manager";
import type { ResizeSession } from "@/features/canvas/resize/resize-session";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

/** 快速构造一个节点 */
function node(id: string, overrides: Record<string, unknown> = {}): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x: 100, y: 200 },
    data: { label: id, content: "" },
    ...overrides,
  } as AnyNode;
}

/** 位置帧接收方替身：本文件只验证分流，不验证会话内部行为 */
function dragSession(active = false): DragPreviewSession {
  return {
    isActive: () => active,
    preview: vi.fn(),
    commit: vi.fn(),
  } as unknown as DragPreviewSession;
}

function resizeSession(resizingNodeId: string | null = null): ResizeSession {
  return {
    isResizingNode: (id: string) => id === resizingNodeId,
  } as unknown as ResizeSession;
}

function renderNodeChanges(options?: { dragActive?: boolean; resizingNodeId?: string | null }) {
  return renderHook(() =>
    useCanvasNodeChanges({
      dragSession: dragSession(options?.dragActive),
      resizeSession: resizeSession(options?.resizingNodeId),
    }),
  );
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
  saveManager.resetForProjectSwitch();
});

afterEach(() => {
  saveManager.resetForProjectSwitch();
});

describe("同帧连续两次 onNodesChange（生产 hook）", () => {
  it("单次派发内 select + position：两次变更都落地", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });
    const { result } = renderNodeChanges();

    const changes: NodeChange<AnyNode>[] = [
      { type: "select", id: "n0", selected: true },
      { type: "position", id: "n0", position: { x: 500, y: 500 }, dragging: false },
    ];
    act(() => result.current.handleNodesChange(changes));

    const stored = useCanvasStore.getState().nodes[0];
    expect(stored.selected).toBe(true);
    expect(stored.position).toEqual({ x: 500, y: 500 });
  });

  it("分两次派发 select 与 position：第二次仍以 store 实时状态为基底", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });
    const { result } = renderNodeChanges();

    act(() => {
      result.current.handleNodesChange([{ type: "select", id: "n0", selected: true }]);
      result.current.handleNodesChange([
        { type: "position", id: "n0", position: { x: 500, y: 500 }, dragging: false },
      ]);
    });

    const stored = useCanvasStore.getState().nodes[0];
    // 若第二次以过期闭包基底计算，选中会被覆盖回 false
    expect(stored.selected).toBe(true);
    expect(stored.position).toEqual({ x: 500, y: 500 });
  });

  it("单次派发内 select + dimensions：实测尺寸与选中都落地", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });
    const { result } = renderNodeChanges();

    act(() =>
      result.current.handleNodesChange([
        { type: "select", id: "n0", selected: true },
        { type: "dimensions", id: "n0", dimensions: { width: 320, height: 180 } },
      ]),
    );

    const stored = useCanvasStore.getState().nodes[0];
    expect(stored.selected).toBe(true);
    expect(stored.measured).toEqual({ width: 320, height: 180 });
  });

  it("选中节点的尺寸回传在建会话中消费：store 不重复写入尺寸", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });
    const { result } = renderNodeChanges({ resizingNodeId: "n0" });

    act(() =>
      result.current.handleNodesChange([
        { type: "select", id: "n0", selected: true },
        { type: "dimensions", id: "n0", dimensions: { width: 320, height: 180 } },
      ]),
    );

    const stored = useCanvasStore.getState().nodes[0];
    expect(stored.selected).toBe(true);
    expect(stored.measured).toBeUndefined();
  });
});

describe("同帧连续两次 onEdgesChange（生产 hook）", () => {
  const edge = (id: string, source: string, target: string): Edge => ({
    id,
    source,
    target,
  });

  it("逐次派发的两次选中都保留（基底取 store 实时状态）", () => {
    useCanvasStore.setState({ edges: [edge("e0", "n0", "n1"), edge("e1", "n1", "n2")] });
    const { result } = renderHook(() => useCanvasEdgeChanges());

    act(() => {
      result.current.handleEdgesChange([{ type: "select", id: "e0", selected: true }]);
      result.current.handleEdgesChange([{ type: "select", id: "e1", selected: true }]);
    });

    const edges = useCanvasStore.getState().edges;
    expect(edges.find((e) => e.id === "e0")?.selected).toBe(true);
    expect(edges.find((e) => e.id === "e1")?.selected).toBe(true);
  });

  it("单次派发内两条 select 都落地", () => {
    useCanvasStore.setState({ edges: [edge("e0", "n0", "n1"), edge("e1", "n1", "n2")] });
    const { result } = renderHook(() => useCanvasEdgeChanges());

    const changes: EdgeChange<Edge>[] = [
      { type: "select", id: "e0", selected: true },
      { type: "select", id: "e1", selected: true },
    ];
    act(() => result.current.handleEdgesChange(changes));

    expect(useCanvasStore.getState().edges.every((e) => e.selected === true)).toBe(true);
  });
});
