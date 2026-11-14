/**
 * useBatchConnectDrag：批量接驳的生产拖拽逻辑。
 *
 * 覆盖扇出/扇入建对、空白处创建连接节点、误触阈值（含 connecting 延后）、
 * 非左键过滤、多指指针隔离、pointerup 位移补判、拖回参与集取消、
 * pointercancel / 窗口失焦清理、组件卸载清理与重入保护。CanvasSurface 只负责把该 hook 接到
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

type PointerOverrides = { button?: number; isPrimary?: boolean; pointerId?: number };

function pointerEvent(
  clientX: number,
  clientY: number,
  overrides: PointerOverrides = {},
): ReactPointerEvent {
  return {
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    clientX,
    clientY,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    ...overrides,
  } as unknown as ReactPointerEvent;
}

/** window 监听器收到的是原生事件：为 jsdom 的 MouseEvent 补上 pointerId。 */
function windowPointerEvent(
  type: "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  init: { pointerId?: number; button?: number; buttons?: number } = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    clientX,
    clientY,
    button: init.button ?? 0,
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

function pointerMove(
  clientX: number,
  clientY: number,
  init: { pointerId?: number; buttons?: number } = {},
): void {
  act(() => {
    window.dispatchEvent(windowPointerEvent("pointermove", clientX, clientY, init));
  });
}

function setup(direction: "output" | "input" = "output") {
  const onConnect = vi.fn();
  const onConnectToBlank = vi.fn();
  const onDragStart = vi.fn();
  const onDragEnd = vi.fn();
  const screenToFlowPosition = vi.fn((p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }));

  const { result, unmount } = renderHook(() => useBatchConnectDrag({
    direction,
    getParticipantIds: () => ["a", "b"],
    onConnect,
    onConnectToBlank,
    onDragStart,
    onDragEnd,
    screenToFlowPosition,
  }));

  return { result, unmount, onConnect, onConnectToBlank, onDragStart, onDragEnd, screenToFlowPosition };
}

function pointerUp(
  clientX: number,
  clientY: number,
  init: { pointerId?: number; button?: number } = {},
): void {
  act(() => {
    window.dispatchEvent(windowPointerEvent("pointerup", clientX, clientY, init));
  });
}

function pointerCancel(pointerId = 1): void {
  act(() => {
    const event = new Event("pointercancel");
    Object.defineProperty(event, "pointerId", { value: pointerId });
    window.dispatchEvent(event);
  });
}

/** 窗口失焦：浏览器可能不再派发 pointerup / pointercancel，会话必须自行收尾。 */
function windowBlur(): void {
  act(() => {
    window.dispatchEvent(new Event("blur"));
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

    // pointerdown 本身不进入 connecting，越过误触阈值才生成预览束线
    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();

    pointerMove(20, 0);

    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).toEqual({
      sources: [{ x: 1, y: 1 }, { x: 1, y: 1 }],
      to: { x: 40, y: 0 },
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
    pointerMove(20, 0);
    pointerUp(20, 0);

    expect(mocks.buildFanInPairs).toHaveBeenCalledWith(nodes[2], [nodes[0], nodes[1]]);
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "t", target: "a" }]);
  });

  it("拖到空白：携带参与集、画布坐标与屏幕坐标弹出创建菜单", () => {
    const ctx = setup("output");

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 10);
    pointerUp(20, 10);

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).toHaveBeenCalledWith(
      ["a", "b"],
      { x: 40, y: 20 },
      { x: 20, y: 10 },
      "output",
    );
  });

  it("移动小于 4px：视为误触，不进入 connecting、不建边也不弹菜单", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(2, 0);
    pointerUp(2, 0);

    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
  });

  it("拖回参与集：取消，不建边也不弹菜单", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[0]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    pointerUp(20, 0);

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("pointercancel：只清理，不按落点处理", () => {
    const ctx = setup("output");

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    pointerCancel();

    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();
  });

  it("窗口失焦：按取消处理，后续 pointerup 不提交", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).not.toBeNull();

    windowBlur();

    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).toBeNull();
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();

    // 失焦后 pointerup 仍可能才到达：不得按落点补提交
    pointerUp(20, 0);
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("阈值前窗口失焦：不进入 connecting，后续 pointerup 也不提交", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(2, 0);
    windowBlur();

    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();

    pointerUp(400, 0);
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
  });

  it("窗口失焦后可重新开始拖拽", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    windowBlur();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    pointerUp(20, 0);

    expect(ctx.onDragStart).toHaveBeenCalledTimes(2);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(2);
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "a", target: "t" }]);
  });

  it("越过阈值前的 pointercancel：不进入 connecting，也不复位", () => {
    const ctx = setup("output");

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(2, 0);
    pointerCancel();

    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();
  });

  it.each([
    { label: "右键", overrides: { button: 2 } },
    { label: "非主指针", overrides: { isPrimary: false } },
  ])("$label：不拦截默认行为，也不启动拖拽", ({ overrides }) => {
    const ctx = setup("output");
    const event = pointerEvent(0, 0, overrides);

    act(() => { ctx.result.current.startDrag(event); });

    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ctx.onDragStart).not.toHaveBeenCalled();

    pointerMove(20, 0);
    pointerUp(20, 0);

    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();
  });

  it("越过 4px 才进入 connecting，且只进入一次", () => {
    const ctx = setup("output");

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });

    pointerMove(3, 0);
    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();

    pointerMove(4, 0);
    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).not.toBeNull();

    pointerMove(50, 0);
    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview?.to).toEqual({ x: 100, y: 0 });

    pointerUp(50, 0);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("其他指针的 move/up 不驱动也不终止本次拖拽", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0, { pointerId: 1 })); });

    // 第二根手指在阈值前移动/抬起：不得启动 A 的拖拽，也不得清掉 A 的监听
    pointerMove(400, 300, { pointerId: 2 });
    pointerUp(400, 300, { pointerId: 2 });
    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).toBeNull();

    // A 仍能正常启动
    pointerMove(20, 0, { pointerId: 1 });
    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    const preview = ctx.result.current.preview;
    expect(preview?.to).toEqual({ x: 40, y: 0 });

    // A 已开始后，B 的移动/抬起仍不得改预览或提交
    pointerMove(90, 90, { pointerId: 2 });
    pointerUp(90, 90, { pointerId: 2 });
    expect(ctx.result.current.preview).toEqual(preview);
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();

    pointerUp(20, 0, { pointerId: 1 });
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "a", target: "t" }]);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("非左键的 pointerup：按取消处理，不按落点建边/弹菜单", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);

    pointerUp(20, 0, { button: 2 });

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).toBeNull();
  });

  it("move 显示起始左键已松开：立即取消，不再跟随或提交", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);

    // 左右键和弦后松开左键（buttons 只剩右键位）：立即取消
    pointerMove(24, 0, { buttons: 2 });

    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(ctx.result.current.preview).toBeNull();

    pointerUp(24, 0, { button: 2 });
    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("快速甩动只留下远距离 pointerup：补做拖拽开始并正常提交", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    // 最后一次 move 仍在阈值内，落点在 pointerup 才越过阈值
    pointerMove(2, 0);
    expect(ctx.onDragStart).not.toHaveBeenCalled();

    pointerUp(40, 0);

    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "a", target: "t" }]);
  });

  it("拖拽中组件卸载：结束会话并按函数身份移除监听，后续 pointerup 不提交", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    // 在 startDrag 之前安装：只捕获本次拖拽注册到 window 的三个监听器
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    try {
      act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
      pointerMove(20, 0);
      expect(ctx.onDragStart).toHaveBeenCalledTimes(1);
      expect(ctx.result.current.preview).not.toBeNull();

      const registered = addListener.mock.calls
        .filter(([type]) =>
          type === "pointermove" || type === "pointerup" || type === "pointercancel"
          || type === "blur")
        .map(([type, listener]) => [type, listener] as const);
      expect(registered.map(([type]) => type)).toEqual([
        "pointermove",
        "pointerup",
        "pointercancel",
        "blur",
      ]);

      // Escape 清空选区 / 组节点删除等会在拖拽中卸载消费者
      ctx.unmount();

      // 必须是同一函数身份被注销：只断言「移除了某类监听」无法发现遗漏
      for (const [type, listener] of registered) {
        expect(removeListener).toHaveBeenCalledWith(type, listener);
      }
      expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
      expect(mocks.clearConnectionTilt).toHaveBeenCalled();

      // 卸载后归同一指针的 pointermove/pointerup 不再派发给过期会话
      pointerMove(400, 0);
      pointerUp(400, 0);

      expect(ctx.onConnect).not.toHaveBeenCalled();
      expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
      expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
      // 卸载清理只结束会话一次；后续事件不得再次触发清理副作用
      expect(mocks.clearConnectionTilt).toHaveBeenCalledTimes(1);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("阈值前组件卸载：不触发 connecting 复位，后续 pointerup 也不提交", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(2, 0);
    ctx.unmount();

    expect(ctx.onDragStart).not.toHaveBeenCalled();
    expect(ctx.onDragEnd).not.toHaveBeenCalled();

    pointerUp(400, 0);

    expect(ctx.onConnect).not.toHaveBeenCalled();
    expect(ctx.onConnectToBlank).not.toHaveBeenCalled();
  });

  it("会话结束后卸载：清理幂等，不重复调用 onDragEnd", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);
    pointerUp(20, 0);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(mocks.clearConnectionTilt).toHaveBeenCalledTimes(1);

    ctx.unmount();

    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
    expect(ctx.onConnect).toHaveBeenCalledTimes(1);
    expect(mocks.clearConnectionTilt).toHaveBeenCalledTimes(1);

    // 会话已在事件路径结束：卸载后的同类事件仍不得重新提交
    pointerUp(400, 0);
    expect(ctx.onConnect).toHaveBeenCalledTimes(1);
  });

  it("重入保护：拖拽进行中再次 startDrag 不会叠加第二套监听", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    act(() => { ctx.result.current.startDrag(pointerEvent(5, 5)); });

    pointerMove(20, 0);

    expect(ctx.onDragStart).toHaveBeenCalledTimes(1);

    pointerUp(20, 0);

    expect(ctx.onConnect).toHaveBeenCalledTimes(1);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    { direction: "output" as const, connectable: true, expected: "ok" },
    { direction: "output" as const, connectable: false, expected: "blocked" },
    { direction: "input" as const, connectable: true, expected: "ok" },
    { direction: "input" as const, connectable: false, expected: "blocked" },
  ])(
    "$direction 方向可连=$connectable 时按 $expected 倾斜，并随每次 move 更新",
    ({ direction, connectable, expected }) => {
      const ctx = setup(direction);
      mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);
      mocks.pairsWouldCreate.mockReturnValue(connectable);
      const pairs = direction === "output"
        ? [{ source: "a", target: "t" }]
        : [{ source: "t", target: "a" }];
      (direction === "output" ? mocks.buildFanoutPairs : mocks.buildFanInPairs)
        .mockReturnValue(pairs);

      act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
      pointerMove(20, 0);

      // 反馈与松手共用 buildPairs + pairsWouldCreate，且方向决定构建器
      if (direction === "output") {
        expect(mocks.buildFanoutPairs).toHaveBeenCalledWith([nodes[0], nodes[1]], nodes[2]);
        expect(mocks.buildFanInPairs).not.toHaveBeenCalled();
      } else {
        expect(mocks.buildFanInPairs).toHaveBeenCalledWith(nodes[2], [nodes[0], nodes[1]]);
        expect(mocks.buildFanoutPairs).not.toHaveBeenCalled();
      }
      expect(mocks.pairsWouldCreate).toHaveBeenCalledWith(pairs, []);
      expect(mocks.applyConnectionTilt).toHaveBeenLastCalledWith(
        { id: "t", box: { x: 0, y: 0, width: 100, height: 100 } },
        { x: 40, y: 0 },
        expected,
      );
      expect(mocks.clearConnectionTilt).not.toHaveBeenCalled();

      // 规则 4.1：越过阈值后的每次 move 都更新终点并重新判定倾斜
      pointerMove(30, 40);

      expect(mocks.findNodeAtFlowPoint).toHaveBeenCalledTimes(2);
      expect(mocks.applyConnectionTilt).toHaveBeenCalledTimes(2);
      expect(mocks.applyConnectionTilt).toHaveBeenLastCalledWith(
        { id: "t", box: { x: 0, y: 0, width: 100, height: 100 } },
        { x: 60, y: 80 },
        expected,
      );
      expect(ctx.result.current.preview?.to).toEqual({ x: 60, y: 80 });
      expect(mocks.clearConnectionTilt).not.toHaveBeenCalled();
    }
  );

  it("未命中节点：清除倾斜，不产生 ok/blocked 反馈", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(null);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);

    expect(mocks.applyConnectionTilt).not.toHaveBeenCalled();
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
  });

  it("命中节点但没有有效盒：清除倾斜", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);
    mocks.getNodeBox.mockReturnValue(null);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);

    expect(mocks.applyConnectionTilt).not.toHaveBeenCalled();
    expect(mocks.clearConnectionTilt).toHaveBeenCalled();
  });

  it.each([
    { direction: "output" as const, side: "right" },
    { direction: "input" as const, side: "left" },
  ])("$direction 预览束线从参与节点的 $side 缘锚点出发", ({ direction, side }) => {
    const ctx = setup(direction);
    mocks.nodeEdgeAnchor.mockImplementation((node: NodeLike) => ({
      x: node.id === "a" ? 1 : 2,
      y: 3,
    }));

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0)); });
    pointerMove(20, 0);

    expect(mocks.nodeEdgeAnchor).toHaveBeenNthCalledWith(1, nodes[0], side, expect.any(Map));
    expect(mocks.nodeEdgeAnchor).toHaveBeenNthCalledWith(2, nodes[1], side, expect.any(Map));
    expect(ctx.result.current.preview).toEqual({
      sources: [{ x: 1, y: 3 }, { x: 2, y: 3 }],
      to: { x: 40, y: 0 },
    });
  });

  it("参与集在起手时冻结：拖动中变化不改变反馈与提交", () => {
    let participantIds = ["a", "b"];
    const getParticipantIds = vi.fn(() => participantIds);
    const onConnect = vi.fn();

    const { result } = renderHook(() => useBatchConnectDrag({
      direction: "output",
      getParticipantIds,
      onConnect,
      onConnectToBlank: vi.fn(),
      onDragStart: vi.fn(),
      onDragEnd: vi.fn(),
      screenToFlowPosition: (p) => ({ x: p.x * 2, y: p.y * 2 }),
    }));

    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { result.current.startDrag(pointerEvent(0, 0)); });
    expect(getParticipantIds).toHaveBeenCalledTimes(1);

    // 起手后组成员 / 选区变化：本次会话仍使用起手时冻结的参与集
    participantIds = ["a"];
    pointerMove(20, 0);
    pointerUp(20, 0);

    expect(getParticipantIds).toHaveBeenCalledTimes(1);
    expect(mocks.buildFanoutPairs).toHaveBeenCalledWith([nodes[0], nodes[1]], nodes[2]);
    expect(onConnect).toHaveBeenCalledWith([{ source: "a", target: "t" }]);
  });

  it("参与集冻结：空白落点仍携带起手时的参与集", () => {
    let participantIds = ["a", "b"];
    const getParticipantIds = vi.fn(() => participantIds);
    const onConnectToBlank = vi.fn();

    const { result } = renderHook(() => useBatchConnectDrag({
      direction: "output",
      getParticipantIds,
      onConnect: vi.fn(),
      onConnectToBlank,
      onDragStart: vi.fn(),
      onDragEnd: vi.fn(),
      screenToFlowPosition: (p) => ({ x: p.x * 2, y: p.y * 2 }),
    }));

    mocks.findNodeAtFlowPoint.mockReturnValue(null);

    act(() => { result.current.startDrag(pointerEvent(0, 0)); });
    // 起手后参与集变化：空白提交仍必须使用冻结集
    participantIds = ["a"];
    pointerMove(20, 10);
    pointerUp(20, 10);

    expect(getParticipantIds).toHaveBeenCalledTimes(1);
    expect(onConnectToBlank).toHaveBeenCalledWith(
      ["a", "b"],
      { x: 40, y: 20 },
      { x: 20, y: 10 },
      "output",
    );
  });

  it("其他指针的 pointercancel 不终止本次拖拽", () => {
    const ctx = setup("output");
    mocks.findNodeAtFlowPoint.mockReturnValue(nodes[2]);

    act(() => { ctx.result.current.startDrag(pointerEvent(0, 0, { pointerId: 1 })); });
    pointerMove(20, 0, { pointerId: 1 });
    expect(ctx.result.current.preview).not.toBeNull();

    pointerCancel(2);

    expect(ctx.onDragEnd).not.toHaveBeenCalled();
    expect(ctx.result.current.preview).not.toBeNull();

    // 主指针仍可正常提交
    pointerUp(20, 0, { pointerId: 1 });
    expect(ctx.onConnect).toHaveBeenCalledWith([{ source: "a", target: "t" }]);
    expect(ctx.onDragEnd).toHaveBeenCalledTimes(1);
  });
});
