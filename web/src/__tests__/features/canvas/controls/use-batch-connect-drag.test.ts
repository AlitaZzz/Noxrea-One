/**
 * useBatchConnectDrag：批量接驳的生产拖拽逻辑。
 *
 * 覆盖扇出/扇入建对、空白处创建连接节点、误触阈值、拖回参与集取消、
 * pointercancel 清理与重入保护。CanvasSurface 只负责把该 hook 接到
 * BatchConnectContext / 轨道组件，行为口径以本测试为准。
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  findNodeAtFlowPoint: vi.fn(),
  getNodeBox: vi.fn(),
  nodeEdgeAnchor: vi.fn(),
  buildFanoutPairs: vi.fn(),
  buildFanInPairs: vi.fn(),
  pairsWouldCreate: vi.fn(),
  applyConnectionTilt: vi.fn(),
  clearConnectionTilt: vi.fn(),
}));

vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: { getState: mocks.getState },
}));
vi.mock("@/features/canvas/shared/node-hit-test", () => ({
  findNodeAtFlowPoint: mocks.findNodeAtFlowPoint,
  getNodeBox: mocks.getNodeBox,
  nodeEdgeAnchor: mocks.nodeEdgeAnchor,
}));
vi.mock("@/features/canvas/shared/connection-rules", () => ({
  buildFanoutPairs: mocks.buildFanoutPairs,
  buildFanInPairs: mocks.buildFanInPairs,
  pairsWouldCreate: mocks.pairsWouldCreate,
}));
vi.mock("@/features/canvas/controls/connection-tilt", () => ({
  applyConnectionTilt: mocks.applyConnectionTilt,
  clearConnectionTilt: mocks.clearConnectionTilt,
}));

import { useBatchConnectDrag } from "@/features/canvas/controls/use-batch-connect-drag";

type NodeLike = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

const nodes: NodeLike[] = [
  { id: "a", type: "image", position: { x: 0, y: 0 }, data: {} },
  { id: "b", type: "image", position: { x: 100, y: 0 }, data: {} },
  { id: "t", type: "video", position: { x: 400, y: 0 }, data: {} },
];

function pointerEvent(clientX: number, clientY: number): ReactPointerEvent {
  return {
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    clientX,
    clientY,
  } as unknown as ReactPointerEvent;
}

function setup(direction: "output" | "input" = "output") {
  const onConnect = vi.fn();
  const onConnectToBlank = vi.fn();
  const onDragStart = vi.fn();
  const onDragEnd = vi.fn();
  const screenToFlowPosition = vi.fn((p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }));

  const { result } = renderHook(() => useBatchConnectDrag({
    direction,
    getParticipantIds: () => ["a", "b"],
    onConnect,
    onConnectToBlank,
    onDragStart,
    onDragEnd,
    screenToFlowPosition,
  }));

  return { result, onConnect, onConnectToBlank, onDragStart, onDragEnd, screenToFlowPosition };
}

function pointerUp(clientX: number, clientY: number): void {
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { clientX, clientY }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockImplementation(() => ({ nodes, edges: [] }));
  mocks.nodeEdgeAnchor.mockReturnValue({ x: 1, y: 1 });
  mocks.findNodeAtFlowPoint.mockReturnValue(null);
  mocks.buildFanoutPairs.mockReturnValue([{ source: "a", target: "t" }]);
  mocks.buildFanInPairs.mockReturnValue([{ source: "t", target: "a" }]);
  mocks.pairsWouldCreate.mockReturnValue(true);
  mocks.getNodeBox.mockReturnValue({ x: 0, y: 0, width: 100, height: 100 });
});

describe("useBatchConnectDrag", () => {
  it("扇出：拖到非参与节点，按 buildFanoutPairs 建对并清理拖拽状态", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });

    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).toEqual({
      sources: [{ x: 1, y: 1 }, { x: 1, y: 1 }],
      to: { x: 0, y: 0 },
    });

    pointerUp(20, 0);

    expect(mocks.buildFanoutPairs).toHaveBeenCalledWith(
      [nodes[0], nodes[1]],
      nodes[2],
    );
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "a", target: "t" }]);
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();
  });

  it("扇入：拖到非参与节点，按 buildFanInPairs 建对", () => {
    const ctx = setup("input");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerUp(20, 0);

    expect(mocks.buildFanInPairs).toHaveBeenCalledWith(nodes[2], [nodes[0], nodes[1]]);
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "t", target: "a" }]);
  });

  it("拖到空白：携带参与集、画布坐标与屏幕坐标弹出创建菜单", () => {
    const ctx = setup("output");

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerUp(20, 10);

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).toHaveBeenCalledWith(
      ["a", "b"],
      { x: 40, y: 20 },
      { x: 20, y: 10 },
      "output",
    );
  });

  it("移动小于 4px：视为误触，不建边也不弹菜单", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerUp(2, 0);

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
  });

  it("拖回参与集：取消，不建边也不弹菜单", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[0]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerUp(20, 0);

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("pointercancel：只清理，不按落点处理", () => {
    const ctx = setup("output");

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    act(() => { window.dispatchEvent(new Event("pointercancel")); });

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();
  });

  it("重入保护：拖拽进行中再次 startDrag 不会叠加第二套监听", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    act(() => { ctx.result.current.startDrag(pointerEvent(5, 5)); });

    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);

    pointerUp(20, 0);

    expect(ctx.onConnect).toHaveBeenCalledTimes(1);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });
});
