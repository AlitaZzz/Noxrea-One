/**
 * useCanvasNodeChanges 生产 hook 的分流语义。
 *
 * 位置帧按 dragging 二分：过程帧只进 DragPreviewSession 预览（不写 store），
 * 终态帧交给会话提交；会话未激活时直接写 store 并标脏。选中 / 实测尺寸写
 * 受控 store；缩放会话活动节点的尺寸回传由会话消费。整理动画遇到位置帧让路。
 * 本文件只驱动 hook 与真实 store / 真实整理动画，会话替身只记录调用。
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { NodeChange } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubRaf } from "@/__tests__/test-utils/raf";
import type { DragPreviewSession } from "@/features/canvas/drag/drag-preview-session";
import { useCanvasNodeChanges } from "@/features/canvas/hooks/use-canvas-node-changes";
import {
  animateNodesTo,
  cancelTidyAnimation,
  isTidyAnimating,
} from "@/features/canvas/hooks/use-tidy-animation";
import {
  type CanvasSaveIntent,
  subscribeCanvasSaveIntent,
} from "@/features/canvas/persistence/save-intent";
import { saveManager } from "@/features/canvas/persistence/save-manager";
import type { ResizeSession } from "@/features/canvas/resize/resize-session";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

function node(id: string, overrides: Record<string, unknown> = {}): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x: 100, y: 200 },
    data: { label: id, content: "" },
    ...overrides,
  } as AnyNode;
}

interface SessionSpies {
  preview: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
}

function makeDragSession(active: boolean): { session: DragPreviewSession; spies: SessionSpies } {
  const spies: SessionSpies = { preview: vi.fn(), commit: vi.fn() };
  return {
    session: {
      isActive: () => active,
      preview: spies.preview,
      commit: spies.commit,
    } as unknown as DragPreviewSession,
    spies,
  };
}

function makeResizeSession(resizingNodeId: string | null): ResizeSession {
  return {
    isResizingNode: (id: string) => id === resizingNodeId,
  } as unknown as ResizeSession;
}

let intents: CanvasSaveIntent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
  saveManager.resetForProjectSwitch();
  intents = [];
  unsubscribe = subscribeCanvasSaveIntent((intent) => intents.push(intent));
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  cancelTidyAnimation();
  saveManager.resetForProjectSwitch();
  vi.unstubAllGlobals();
});

function renderChanges(options: { dragActive?: boolean; resizingNodeId?: string | null } = {}) {
  const drag = makeDragSession(options.dragActive ?? false);
  const hook = renderHook(() =>
    useCanvasNodeChanges({
      dragSession: drag.session,
      resizeSession: makeResizeSession(options.resizingNodeId ?? null),
    }),
  );
  return { ...hook, spies: drag.spies };
}

describe("位置帧分流", () => {
  it("拖动过程帧且会话激活：只进预览，不写 store、不标脏", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result, spies } = renderChanges({ dragActive: true });

    act(() =>
      result.current.handleNodesChange([
        { type: "position", id: "n0", position: { x: 40, y: 50 }, dragging: true },
      ]),
    );

    expect(spies.preview).toHaveBeenCalledWith([{ id: "n0", position: { x: 40, y: 50 } }]);
    expect(spies.commit).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 100, y: 200 });
    expect(intents).toEqual([]);
  });

  it("终态帧且会话激活：交给会话提交，hook 不写 store", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result, spies } = renderChanges({ dragActive: true });

    act(() =>
      result.current.handleNodesChange([
        { type: "position", id: "n0", position: { x: 40, y: 50 }, dragging: false },
      ]),
    );

    expect(spies.commit).toHaveBeenCalledWith([{ id: "n0", position: { x: 40, y: 50 } }]);
    expect(spies.preview).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 100, y: 200 });
  });

  it("会话未激活的过程帧直接写 store 并标脏（debounced）", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result, spies } = renderChanges();

    act(() =>
      result.current.handleNodesChange([
        { type: "position", id: "n0", position: { x: 40, y: 50 }, dragging: true },
      ]),
    );

    expect(spies.preview).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 40, y: 50 });
    expect(intents).toEqual([{ kind: "debounced" }]);
  });

  it("位置未变化的帧不写入、不标脏", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });
    const { result } = renderChanges();

    act(() =>
      result.current.handleNodesChange([
        { type: "position", id: "n0", position: { x: 100, y: 200 }, dragging: false },
      ]),
    );

    // 未变化时 applyNodePositions 返回原数组，hook 在 setNodes 前提前返回
    expect(useCanvasStore.getState().nodes[0]).toBe(n0);
    expect(intents).toEqual([]);
  });

  it("仅切换 dragging 而缺少 position 的帧被忽略", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result, spies } = renderChanges({ dragActive: true });

    act(() =>
      result.current.handleNodesChange([
        { type: "position", id: "n0", dragging: false } as NodeChange<AnyNode>,
      ]),
    );

    expect(spies.preview).not.toHaveBeenCalled();
    expect(spies.commit).not.toHaveBeenCalled();
    expect(intents).toEqual([]);
  });
});

describe("选中、尺寸与结构变更", () => {
  it("select 直接写 store，不标脏、不经过位置会话", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result, spies } = renderChanges({ dragActive: true });

    act(() => result.current.handleNodesChange([{ type: "select", id: "n0", selected: true }]));

    expect(useCanvasStore.getState().nodes[0].selected).toBe(true);
    expect(spies.preview).not.toHaveBeenCalled();
    expect(spies.commit).not.toHaveBeenCalled();
    expect(intents).toEqual([]);
  });

  it("缩放会话活动节点的尺寸回传不写 store", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result } = renderChanges({ resizingNodeId: "n0" });

    act(() =>
      result.current.handleNodesChange([
        { type: "dimensions", id: "n0", dimensions: { width: 320, height: 180 } },
      ]),
    );

    expect(useCanvasStore.getState().nodes[0].measured).toBeUndefined();
  });

  it("其它节点的尺寸回传照常写入 store", () => {
    useCanvasStore.setState({ nodes: [node("n0"), node("n1")] });
    const { result } = renderChanges({ resizingNodeId: "n1" });

    act(() =>
      result.current.handleNodesChange([
        { type: "dimensions", id: "n0", dimensions: { width: 320, height: 180 } },
      ]),
    );

    expect(useCanvasStore.getState().nodes.find((n) => n.id === "n0")?.measured).toEqual({
      width: 320,
      height: 180,
    });
  });

  it("remove 等结构变更被过滤：删除只由画布业务动作提交", () => {
    useCanvasStore.setState({ nodes: [node("n0")] });
    const { result } = renderChanges();

    act(() =>
      result.current.handleNodesChange([
        { type: "remove", id: "n0" } as NodeChange<AnyNode>,
      ]),
    );

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(intents).toEqual([]);
  });
});

describe("整理动画让路", () => {
  it("动画进行中收到位置帧：取消动画，节点停在目标写入值", () => {
    stubRaf();
    useCanvasStore.setState({ nodes: [node("n0")] });
    animateNodesTo(new Map([["n0", { x: 900, y: 900 }]]), { duration: 300 });
    expect(isTidyAnimating()).toBe(true);

    const { result } = renderChanges();
    act(() =>
      result.current.handleNodesChange([
        { type: "position", id: "n0", position: { x: 40, y: 50 }, dragging: false },
      ]),
    );

    expect(isTidyAnimating()).toBe(false);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 40, y: 50 });
  });

  it("仅选中变更不取消整理动画", () => {
    stubRaf();
    useCanvasStore.setState({ nodes: [node("n0")] });
    animateNodesTo(new Map([["n0", { x: 900, y: 900 }]]), { duration: 300 });

    const { result } = renderChanges();
    act(() => result.current.handleNodesChange([{ type: "select", id: "n0", selected: true }]));

    expect(isTidyAnimating()).toBe(true);
  });
});
