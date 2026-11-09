// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubRaf } from "@/__tests__/test-utils/raf";
import { ResizeSession } from "@/features/canvas/resize/resize-session";
import type { AnyNode } from "@/features/canvas/types";
import type { HistorySnapshot } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

interface PointerInit {
  x: number;
  y: number;
  pointerId?: number;
}

function pointerEvent(type: string, init: PointerInit): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: true },
    pointerType: { value: "mouse" },
  });
  return event as unknown as PointerEvent;
}

const node = (id: string, extra: Record<string, unknown> = {}): AnyNode =>
  ({
    id,
    type: NODE_TYPE.TEXT,
    position: { x: 10, y: 20 },
    data: {},
    selected: true,
    style: { width: 200, height: 100 },
    measured: { width: 200, height: 100 },
    ...extra,
  }) as unknown as AnyNode;

const snapshotOf = (nodes: AnyNode[]): HistorySnapshot => ({
  nodes,
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  minimapVisible: true,
  snapEnabled: true,
});

const sessions: ResizeSession[] = [];

interface HarnessOptions {
  nodes?: AnyNode[];
  /** 节点 wrapper 的原始行内尺寸（模拟 React Flow 由 style 写入） */
  inline?: { width: string; height: string };
  rect?: { width: number; height: number };
}

function createHarness(options: HarnessOptions = {}) {
  let store = options.nodes ?? [node("n1"), node("n2", { position: { x: 300, y: 20 } })];
  const initialNodes = store;
  const setNodes = vi.fn((next: AnyNode[]) => {
    store = next;
  });
  const markDirtyImmediate = vi.fn();
  const pushHistory = vi.fn();
  const snapshot = snapshotOf(initialNodes);
  const takeSnapshot = vi.fn(() => snapshot);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const wrappers = new Map<string, HTMLElement>();
  for (const item of initialNodes) {
    const wrapper = document.createElement("div");
    wrapper.className = "react-flow__node";
    wrapper.dataset.id = item.id;
    const inline = options.inline ?? { width: "200px", height: "100px" };
    wrapper.style.width = inline.width;
    wrapper.style.height = inline.height;
    const rect = options.rect ?? { width: 200, height: 100 };
    wrapper.getBoundingClientRect = () => ({
      ...rect,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: rect.width,
      bottom: rect.height,
      toJSON: () => ({}),
    });
    container.appendChild(wrapper);
    wrappers.set(item.id, wrapper);
  }

  const session = new ResizeSession({
    root: { current: container },
    getNodes: () => store,
    setNodes,
    markDirtyImmediate,
    takeSnapshot,
    pushHistory,
  });
  sessions.push(session);

  return {
    session,
    container,
    wrappers,
    setNodes,
    markDirtyImmediate,
    pushHistory,
    takeSnapshot,
    snapshot,
    initialNodes,
    getNodes: () => store,
    /** 直接替换节点数组（不经过 setNodes mock），模拟外部写入 */
    replaceNodes: (next: AnyNode[]) => {
      store = next;
    },
    begin(
      pointer: PointerInit = { x: 0, y: 0 },
      extra: Partial<{ nodeId: string; zoom: number; minWidth: number; minHeight: number }> = {},
    ) {
      return session.begin({
        nodeId: extra.nodeId ?? "n1",
        pointerId: pointer.pointerId ?? 1,
        pointer: { x: pointer.x, y: pointer.y },
        zoom: extra.zoom ?? 1,
        minWidth: extra.minWidth ?? 40,
        minHeight: extra.minHeight ?? 30,
      });
    },
    move(pointer: PointerInit) {
      window.dispatchEvent(pointerEvent("pointermove", pointer));
    },
    release(pointer: PointerInit) {
      window.dispatchEvent(pointerEvent("pointerup", pointer));
    },
    cancel(pointer: PointerInit = { x: 0, y: 0 }) {
      window.dispatchEvent(pointerEvent("pointercancel", pointer));
    },
    blur() {
      window.dispatchEvent(new Event("blur"));
    },
  };
}

function wrapperSize(wrapper: HTMLElement) {
  return { width: wrapper.style.width, height: wrapper.style.height };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ResizeSession 预览", () => {
  it("预览帧只按 rAF 合并写 DOM，不写 store、不落库、不压历史", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();

    h.move({ x: 30, y: 40 });
    h.move({ x: 50, y: 60 });
    // 帧未到：DOM 仍是原尺寸，store 引用不变
    expect(wrapperSize(wrapper)).toEqual({ width: "200px", height: "100px" });
    expect(h.getNodes()).toBe(h.initialNodes);

    // 推进帧：只应用最新指针位置，一次 DOM 写入
    raf.flush();
    expect(wrapperSize(wrapper)).toEqual({ width: "250px", height: "160px" });
    expect(h.setNodes).not.toHaveBeenCalled();
    expect(h.markDirtyImmediate).not.toHaveBeenCalled();
    expect(h.pushHistory).not.toHaveBeenCalled();
    expect(h.getNodes()).toBe(h.initialNodes);
  });

  it("尺寸与上一帧相同则跳过 DOM 写入", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 30, y: 40 });
    raf.flush();
    expect(wrapperSize(wrapper)).toEqual({ width: "230px", height: "140px" });

    // 同一尺寸的后续帧不得改动行内值：用一个哨兵值证明没有再写
    wrapper.style.width = "999px";
    h.move({ x: 30, y: 40 });
    raf.flush();
    expect(wrapper.style.width).toBe("999px");
  });

  it("指针位移按按下时 zoom 换算，缩放中的 zoom 变化不影响口径", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin({ x: 0, y: 0 }, { zoom: 2 });

    h.move({ x: 40, y: 20 });
    raf.flush();
    expect(wrapperSize(wrapper)).toEqual({ width: "220px", height: "110px" });
  });

  it("只有发起手势的 pointerId 参与会话", () => {
    stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin({ x: 0, y: 0, pointerId: 7 });

    h.move({ x: 80, y: 80, pointerId: 8 });
    expect(wrapperSize(wrapper)).toEqual({ width: "200px", height: "100px" });
  });

  it("节点或 wrapper 不存在时不建立会话", () => {
    const raf = stubRaf();
    const h = createHarness({ nodes: [node("n1")] });
    h.wrappers.get("n1")!.remove();
    expect(h.begin({ x: 0, y: 0 })).toBe(false);

    h.move({ x: 50, y: 50 });
    raf.flush();
    expect(h.setNodes).not.toHaveBeenCalled();
    expect(h.session.isResizingNode("n1")).toBe(false);
  });
});

describe("ResizeSession 提交", () => {
  it("松手恰好一次 setNodes：写最终 style 与 measured，position 不变", () => {
    const raf = stubRaf();
    const h = createHarness();
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();
    h.release({ x: 50, y: 60 });

    expect(h.setNodes).toHaveBeenCalledTimes(1);
    const next = h.setNodes.mock.calls[0][0];
    const resized = next.find((n) => n.id === "n1")!;
    expect(resized.style).toMatchObject({ width: 250, height: 160 });
    expect(resized.measured).toEqual({ width: 250, height: 160 });
    expect(resized.position).toEqual({ x: 10, y: 20 });
    // 其它节点保持原引用
    expect(next.find((n) => n.id === "n2")).toBe(h.initialNodes[1]);
    expect(h.markDirtyImmediate).toHaveBeenCalledTimes(1);
    expect(h.takeSnapshot).toHaveBeenCalledTimes(1);
    expect(h.pushHistory).toHaveBeenCalledTimes(1);
    expect(h.pushHistory).toHaveBeenCalledWith(h.snapshot);
  });

  it("pointerup 坐标就是最终帧，未执行的 rAF 被取消", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 50, y: 60 });
    // 未 flush 就松手：提交必须用 pointerup 坐标，而不是停在上一帧
    h.release({ x: 30, y: 20 });
    expect(wrapperSize(wrapper)).toEqual({ width: "230px", height: "120px" });

    const resized = h.setNodes.mock.calls[0][0].find((n) => n.id === "n1")!;
    expect(resized.style).toMatchObject({ width: 230, height: 120 });
    // 已取消的帧不再写 DOM
    wrapper.style.width = "999px";
    raf.flush();
    expect(wrapper.style.width).toBe("999px");
  });

  it("提交后等待渲染层采用，再释放会话；行内尺寸保留终值", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();
    h.release({ x: 50, y: 60 });

    // 等待期：本节点的尺寸回传仍由会话消费
    expect(h.session.isResizingNode("n1")).toBe(true);
    expect(h.session.isResizingNode("n2")).toBe(false);
    h.session.syncRenderedNodes();
    expect(h.session.isResizingNode("n1")).toBe(false);
    expect(h.session.isResizingNode("n1")).toBe(false);
    expect(wrapperSize(wrapper)).toEqual({ width: "250px", height: "160px" });
  });

  it("无位移点按不写 store、不压历史，并恢复原始行内尺寸", () => {
    const h = createHarness();
    h.begin();
    h.release({ x: 0, y: 0 });

    expect(h.setNodes).not.toHaveBeenCalled();
    expect(h.markDirtyImmediate).not.toHaveBeenCalled();
    expect(h.pushHistory).not.toHaveBeenCalled();
    expect(h.session.isResizingNode("n1")).toBe(false);
    expect(wrapperSize(h.wrappers.get("n1")!)).toEqual({ width: "200px", height: "100px" });
  });

  it("拖出后回到起始尺寸同样不提交，原始行内尺寸恢复", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();
    h.move({ x: 0, y: 0 });
    raf.flush();
    h.release({ x: 0, y: 0 });

    expect(h.setNodes).not.toHaveBeenCalled();
    expect(h.pushHistory).not.toHaveBeenCalled();
    expect(wrapperSize(wrapper)).toEqual({ width: "200px", height: "100px" });
  });

  it("pointercancel / window blur 按最后一帧提交", () => {
    const raf = stubRaf();
    const cancelHarness = createHarness();
    cancelHarness.begin();
    cancelHarness.move({ x: 30, y: 40 });
    raf.flush();
    cancelHarness.cancel();
    expect(cancelHarness.setNodes).toHaveBeenCalledTimes(1);
    expect(cancelHarness.setNodes.mock.calls[0][0].find((n) => n.id === "n1")!.style)
      .toMatchObject({ width: 230, height: 140 });

    const blurHarness = createHarness();
    blurHarness.begin();
    blurHarness.move({ x: 20, y: 10 });
    raf.flush();
    blurHarness.blur();
    expect(blurHarness.setNodes).toHaveBeenCalledTimes(1);
    expect(blurHarness.setNodes.mock.calls[0][0].find((n) => n.id === "n1")!.style)
      .toMatchObject({ width: 220, height: 110 });
    expect(blurHarness.session.isResizingNode("n1")).toBe(true); // 等渲染层采用后释放
  });

  it("提交使用最新 store 数组为基准，其它节点的外部写入不丢失", () => {
    const raf = stubRaf();
    const h = createHarness();
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();

    const external = h.getNodes().map((n) =>
      n.id === "n2" ? { ...n, hidden: true } : n,
    );
    h.replaceNodes(external);
    h.session.syncRenderedNodes(); // 被缩放节点几何未变 → 继续
    expect(h.session.isResizingNode("n1")).toBe(true);

    h.release({ x: 50, y: 60 });
    const next = h.setNodes.mock.calls[0][0];
    expect(next.find((n) => n.id === "n2")!.hidden).toBe(true);
    expect(next.find((n) => n.id === "n1")!.style).toMatchObject({ width: 250, height: 160 });
  });
});

describe("ResizeSession 外部写入与生命周期", () => {
  it("被缩放节点几何未变时继续预览", () => {
    const raf = stubRaf();
    const h = createHarness();
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();

    // 引用变化但几何一致（例如只改其它字段）
    h.replaceNodes(h.getNodes().map((n) => ({ ...n })));
    h.session.syncRenderedNodes();
    expect(h.session.isResizingNode("n1")).toBe(true);
    h.release({ x: 50, y: 60 });
    expect(h.setNodes).toHaveBeenCalledTimes(1);
  });

  it("被缩放节点几何被外部改写时取消：零写入，DOM 回到 store 尺寸", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();

    h.replaceNodes(
      h.getNodes().map((n) =>
        n.id === "n1" ? { ...n, style: { width: 320, height: 180 } } : n,
      ),
    );
    h.session.syncRenderedNodes();
    expect(h.session.isResizingNode("n1")).toBe(false);
    expect(h.setNodes).not.toHaveBeenCalled();
    expect(h.pushHistory).not.toHaveBeenCalled();
    expect(wrapperSize(wrapper)).toEqual({ width: "320px", height: "180px" });

    // 监听已移除：后续指针事件不再产生写入
    h.release({ x: 50, y: 60 });
    expect(h.setNodes).not.toHaveBeenCalled();
  });

  it("被缩放节点被删除时取消并恢复原始行内尺寸", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();

    h.replaceNodes(h.getNodes().filter((n) => n.id !== "n1"));
    h.session.syncRenderedNodes();
    expect(h.session.isResizingNode("n1")).toBe(false);
    expect(h.setNodes).not.toHaveBeenCalled();
    expect(wrapperSize(wrapper)).toEqual({ width: "200px", height: "100px" });
  });

  it("自身提交不被误判为外部写入", () => {
    const raf = stubRaf();
    const h = createHarness();
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();
    h.release({ x: 50, y: 60 });

    h.session.syncRenderedNodes();
    expect(h.session.isResizingNode("n1")).toBe(false);
    expect(h.pushHistory).toHaveBeenCalledTimes(1);
  });

  it("dispose 取消未执行的帧、移除监听且不写 store", () => {
    const raf = stubRaf();
    const h = createHarness();
    const wrapper = h.wrappers.get("n1")!;
    h.begin();
    h.move({ x: 50, y: 60 });

    h.session.dispose();
    raf.flush();
    expect(wrapperSize(wrapper)).toEqual({ width: "200px", height: "100px" });
    h.release({ x: 50, y: 60 });
    expect(h.setNodes).not.toHaveBeenCalled();
    expect(h.markDirtyImmediate).not.toHaveBeenCalled();
    expect(h.pushHistory).not.toHaveBeenCalled();
  });

  it("活动期收到新的 begin：先提交上一会话，再按最新 store 建立新会话", () => {
    const raf = stubRaf();
    const h = createHarness();
    h.begin();
    h.move({ x: 50, y: 60 });
    raf.flush();

    const started = h.begin({ x: 0, y: 0 });
    expect(started).toBe(true);
    expect(h.setNodes).toHaveBeenCalledTimes(1);
    expect(h.setNodes.mock.calls[0][0].find((n) => n.id === "n1")!.style)
      .toMatchObject({ width: 250, height: 160 });
    expect(h.session.isResizingNode("n1")).toBe(true);
    expect(h.session.isResizingNode("n1")).toBe(true);
  });

  it("缺失显式 style 时按 wrapper 实测 / zoom 作为起始尺寸", () => {
    const raf = stubRaf();
    const h = createHarness({
      nodes: [node("n1", { style: undefined, measured: undefined })],
      rect: { width: 300, height: 200 },
    });
    h.begin({ x: 0, y: 0 }, { zoom: 2 });
    h.move({ x: 40, y: 20 });
    raf.flush();
    h.release({ x: 40, y: 20 });

    // rect 300×200 屏幕像素 ÷ zoom 2 = 150×100 画布单位；位移 +20/+10
    const resized = h.setNodes.mock.calls[0][0].find((n) => n.id === "n1")!;
    expect(resized.style).toMatchObject({ width: 170, height: 110 });
  });
});
