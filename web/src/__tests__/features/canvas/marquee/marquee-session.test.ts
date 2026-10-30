// @vitest-environment jsdom
import type { Edge } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubRaf } from "@/__tests__/test-utils/raf";
import { MarqueeSession } from "@/features/canvas/marquee/marquee-session";
import type { AnyNode } from "@/features/canvas/types";

import { marqueeBox } from "./fixtures";

const edge = (id: string, source: string, target: string, selected = false): Edge =>
  ({ id, source, target, selected, type: "default" }) as Edge;

interface PointerInit {
  x: number;
  y: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  button?: number;
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
  buttons?: number;
}

function pointerEvent(type: string, init: PointerInit): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    button: init.button ?? 0,
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true },
    pointerType: { value: init.pointerType ?? "mouse" },
  });
  return event as unknown as PointerEvent;
}

const PANE_BOUNDS = {
  left: 0,
  top: 0,
  width: 800,
  height: 600,
  right: 800,
  bottom: 600,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

const sessions: MarqueeSession[] = [];

interface HarnessOptions {
  nodes: AnyNode[];
  edges?: Edge[];
  transform?: [number, number, number];
  projectId?: string;
  nodesSelectionActive?: boolean;
  canStartMarquee?: boolean;
}

function createHarness(options: HarnessOptions) {
  let nodes = options.nodes;
  let edges = options.edges ?? [];
  let transform = options.transform ?? ([0, 0, 1] as [number, number, number]);
  let projectId = options.projectId ?? "p1";
  let nodesSelectionActive = options.nodesSelectionActive ?? false;
  const canStartMarquee = options.canStartMarquee ?? true;

  const container = document.createElement("div");
  // 必须挂到 document 上：window 捕获阶段的 click 抑制依赖完整事件传播路径
  document.body.appendChild(container);
  const pane = document.createElement("div");
  pane.className = "react-flow__pane";
  pane.getBoundingClientRect = () => PANE_BOUNDS;
  container.appendChild(pane);
  const marquee = document.createElement("div");
  marquee.className = "react-flow__selection react-flow__container";
  marquee.dataset.canvasMarquee = "";
  container.appendChild(marquee);
  const wrappers = new Map<string, HTMLElement>();
  for (const item of nodes) {
    const wrapper = document.createElement("div");
    wrapper.className = "react-flow__node";
    wrapper.dataset.id = item.id;
    container.appendChild(wrapper);
    wrappers.set(item.id, wrapper);
  }

  const setNodes = vi.fn((next: AnyNode[]) => {
    nodes = next;
  });
  const setEdges = vi.fn<(next: Edge[], options?: { skipHistory?: boolean }) => void>((next) => {
    edges = next;
  });
  const dispatchInteraction = vi.fn();
  const panBy = vi.fn<(delta: { x: number; y: number }) => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const setNodesSelectionActive = vi.fn((active: boolean) => {
    nodesSelectionActive = active;
  });

  const session = new MarqueeSession({
    root: { current: container },
    getNodes: () => nodes,
    getEdges: () => edges,
    setNodes,
    setEdges,
    dispatchInteraction,
    getProjectId: () => projectId,
    getTransform: () => transform,
    panBy,
    getNodesSelectionActive: () => nodesSelectionActive,
    setNodesSelectionActive,
    canStartMarquee: () => canStartMarquee,
  });
  session.attach();
  sessions.push(session);

  return {
    session,
    container,
    pane,
    marquee,
    wrappers,
    setNodes,
    setEdges,
    dispatchInteraction,
    panBy,
    setNodesSelectionActive,
    getNodes: () => nodes,
    getEdges: () => edges,
    getProjectId: () => projectId,
    getNodesSelectionActive: () => nodesSelectionActive,
    setProjectId: (next: string) => {
      projectId = next;
    },
    /** 直接替换节点数组（不经过 setNodes mock），模拟手势中的外部写入 */
    replaceNodes: (next: AnyNode[]) => {
      nodes = next;
    },
    setTransform: (next: [number, number, number]) => {
      transform = next;
    },
    press(init: PointerInit) {
      pane.dispatchEvent(pointerEvent("pointerdown", init));
    },
    move(init: PointerInit) {
      window.dispatchEvent(pointerEvent("pointermove", init));
    },
    release(init: PointerInit) {
      window.dispatchEvent(pointerEvent("pointerup", init));
    },
  };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarqueeSession", () => {
  it("未达阈值不激活、不写 store、不抑制 click", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0, { selected: true })] });
    const click = vi.fn();
    harness.pane.addEventListener("click", click);

    harness.press({ x: 200, y: 200 });
    harness.move({ x: 200.5, y: 200 });
    harness.release({ x: 200.5, y: 200 });
    harness.pane.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(harness.setNodes).not.toHaveBeenCalled();
    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(false);
    // 候选阶段没有点击抑制：空白点击照常派发
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("恰好等于激活阈值仍按点击处理", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 200, y: 200 });
    harness.move({ x: 201, y: 200 });
    expect(harness.marquee.dataset.active).toBeUndefined();

    // 超过阈值才激活（与 paneClickDistance 的「等于仍算点击」语义一致）
    harness.move({ x: 202, y: 200 });
    expect(harness.marquee.dataset.active).toBe("true");
  });

  it("候选阶段按 Esc 结束手势，后续拖动不再激活", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 50, y: 50 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();
  });

  it("候选阶段切换项目后不再激活，也不写入新项目", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
    });

    harness.press({ x: 50, y: 50 });
    harness.setProjectId("p2");
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();
    expect(harness.dispatchInteraction).not.toHaveBeenCalled();
  });

  it("候选阶段失去按键（窗口外松开）直接结束，不激活", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
    });

    harness.press({ x: 50, y: 50 });
    // 窗口外松开收不到 pointerup：移回时 buttons=0，按点击处理而不是激活
    harness.move({ x: 500, y: 500, buttons: 0 });
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();
    expect(harness.dispatchInteraction).not.toHaveBeenCalled();
  });

  it("无选区时激活与提交都不写 store", () => {
    const raf = stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0), marqueeBox("b", 400, 0)] });

    // 空白区框选：起止矩形不命中任何节点
    harness.press({ x: 200, y: 200 });
    harness.move({ x: 210, y: 210 });
    raf.flush();

    expect(harness.marquee.dataset.active).toBe("true");
    expect(harness.setNodes).not.toHaveBeenCalled();
    expect(harness.setEdges).not.toHaveBeenCalled();
    expect(harness.setNodesSelectionActive).not.toHaveBeenCalled();

    harness.release({ x: 210, y: 210 });

    // 提交无命中、且节点/边/外框状态本就一致：同样不写 store
    expect(harness.setNodes).not.toHaveBeenCalled();
    expect(harness.setEdges).not.toHaveBeenCalled();
    expect(harness.setNodesSelectionActive).not.toHaveBeenCalled();
  });

  it("激活清空已提交选中，帧内只写预览，松手单次提交并等待渲染层释放", () => {
    const raf = stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true }), marqueeBox("b", 400, 0)],
      edges: [edge("e1", "a", "b", true)],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 150, y: 150 });

    // 激活：一次清空节点/边选中，进入框选交互态，不压历史
    expect(harness.setNodes).toHaveBeenCalledTimes(1);
    const cleared = harness.setNodes.mock.calls[0][0] as AnyNode[];
    expect(cleared.every((item) => !item.selected)).toBe(true);
    expect(harness.setEdges).toHaveBeenCalledTimes(1);
    expect(harness.setEdges.mock.calls[0][1]).toEqual({ skipHistory: true });
    expect(harness.dispatchInteraction).toHaveBeenCalledWith("selection-start");
    expect(harness.getNodesSelectionActive()).toBe(false);
    expect(harness.marquee.dataset.active).toBe("true");
    expect(harness.marquee.style.width).toBe("100px");
    expect(harness.marquee.style.transform).toBe("translate(50px, 50px)");
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);
    expect(harness.wrappers.get("b")?.hasAttribute("data-marquee-hit")).toBe(false);

    // 预览帧扩大命中：只写 DOM，不再写 store
    harness.move({ x: 500, y: 500 });
    raf.flush();
    expect(harness.wrappers.get("b")?.hasAttribute("data-marquee-hit")).toBe(true);
    expect(harness.setNodes).toHaveBeenCalledTimes(1);
    expect(harness.setEdges).toHaveBeenCalledTimes(1);

    // 收缩：差量移除
    harness.move({ x: 80, y: 80 });
    raf.flush();
    expect(harness.wrappers.get("b")?.hasAttribute("data-marquee-hit")).toBe(false);
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);

    harness.release({ x: 80, y: 80 });

    // 提交：节点与边各再写一次，节点选中只落在 a
    expect(harness.setNodes).toHaveBeenCalledTimes(2);
    const committed = harness.setNodes.mock.calls[1][0] as AnyNode[];
    expect(committed.find((item) => item.id === "a")?.selected).toBe(true);
    expect(committed.find((item) => item.id === "b")?.selected).toBeFalsy();
    expect(harness.setEdges).toHaveBeenCalledTimes(2);
    expect(harness.setEdges.mock.calls[1][1]).toEqual({ skipHistory: true });
    expect(harness.getNodesSelectionActive()).toBe(true);
    // 渲染层采用之前保留预览属性，避免选中视觉闪断
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);
    expect(harness.marquee.dataset.active).toBe("true");

    harness.session.syncRenderedNodes();

    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(false);
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("视口与指针未变化时不重复写选框与命中属性（验收 2）", () => {
    const raf = stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 150, y: 150 });
    raf.flush();

    // 首帧写入后放置哨兵：下一帧状态未变，不应再写选框样式或命中属性
    harness.marquee.style.transform = "translate(7px, 7px)";
    const wrapper = harness.wrappers.get("a");
    if (!wrapper) throw new Error("wrapper missing");
    const setAttribute = vi.spyOn(wrapper, "setAttribute");
    const removeAttribute = vi.spyOn(wrapper, "removeAttribute");

    raf.flush();

    expect(harness.marquee.style.transform).toBe("translate(7px, 7px)");
    expect(setAttribute).not.toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalled();
  });

  it("提交时任一端点选中即选中该边（验收 6）", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0), marqueeBox("b", 400, 0)],
      edges: [edge("e1", "a", "b")],
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 150, y: 150 });
    harness.release({ x: 150, y: 150 });

    expect(harness.getEdges().find((item) => item.id === "e1")?.selected).toBe(true);
  });

  it.each(["shiftKey", "ctrlKey", "metaKey"] as const)(
    "%s 追加以按下时的已提交选中集为 baseline",
    (modifier) => {
      stubRaf();
      const harness = createHarness({
        nodes: [marqueeBox("a", 0, 0, { selected: true }), marqueeBox("b", 400, 0)],
      });

      harness.press({ x: 350, y: 50, [modifier]: true });
      harness.move({ x: 500, y: 150 });

      expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);
      expect(harness.wrappers.get("b")?.hasAttribute("data-marquee-hit")).toBe(true);

      harness.release({ x: 500, y: 150 });
      const committed = harness.setNodes.mock.calls.at(-1)?.[0] as AnyNode[];
      expect(committed.find((item) => item.id === "a")?.selected).toBe(true);
      expect(committed.find((item) => item.id === "b")?.selected).toBe(true);
    },
  );

  it("按 zoom/平移换算屏幕矩形到 flow 命中", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 150, 50), marqueeBox("b", 500, 0)],
      transform: [0, 0, 0.5],
    });

    // 屏幕 (50,50) → flow (100,100)；屏幕 (150,150) → flow (300,300)
    harness.press({ x: 50, y: 50 });
    harness.move({ x: 150, y: 150 });

    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);
    expect(harness.wrappers.get("b")?.hasAttribute("data-marquee-hit")).toBe(false);
  });

  it("Esc 取消恢复手势前选区与聚合外框状态，且后续 pane click 被吞掉", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      edges: [edge("e1", "a", "b", true)],
      nodesSelectionActive: true,
    });
    const click = vi.fn();
    harness.pane.addEventListener("click", click);

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    expect(harness.getNodes().every((item) => item.selected !== true)).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const restored = harness.setNodes.mock.calls.at(-1)?.[0] as AnyNode[];
    expect(restored.find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getEdges().find((item) => item.id === "e1")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(false);

    // 取消后指针抬起不再提交
    const callsAfterCancel = harness.setNodes.mock.calls.length;
    harness.release({ x: 500, y: 500 });
    expect(harness.setNodes.mock.calls.length).toBe(callsAfterCancel);

    // 取消恢复的选区不能被紧随的 pane click 清掉
    harness.pane.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).not.toHaveBeenCalled();

    // 下一次普通点击恢复正常
    harness.press({ x: 600, y: 300 });
    harness.release({ x: 600, y: 300 });
    harness.pane.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("Esc 取消先恢复快照，全局 Escape 仍照常清空（Spec 规则 9.4）", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0, { selected: true })] });
    // 模拟 use-canvas-keyboard：冒泡阶段未见 defaultPrevented 即清空选区
    const globalEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      harness.setNodes(harness.getNodes().map((item) => ({ ...item, selected: false })));
    };
    window.addEventListener("keydown", globalEscape);

    try {
      harness.press({ x: 50, y: 50 });
      harness.move({ x: 500, y: 500 });
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escape);

      // 会话不消费 Esc：取消恢复完成后，冒泡阶段的全局快捷键仍会清空选区
      expect(escape.defaultPrevented).toBe(false);
      expect(
        harness.setNodes.mock.calls.some((call) =>
          (call[0] as AnyNode[]).some((item) => item.id === "a" && item.selected === true),
        ),
      ).toBe(true);
      expect(harness.getNodes().every((item) => item.selected !== true)).toBe(true);
    } finally {
      window.removeEventListener("keydown", globalEscape);
    }
  });

  it("pointercancel 取消手势并恢复选区", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    window.dispatchEvent(pointerEvent("pointercancel", { x: 500, y: 500 }));

    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("第二指针按下取消并恢复选区", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    expect(harness.getNodes().every((item) => item.selected !== true)).toBe(true);

    // 不同 pointerId 的按下（触屏/手写笔第二指针）：取消当前手势
    harness.press({ x: 300, y: 300, pointerId: 2, pointerType: "touch" });

    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("画布外按下第二指针同样取消手势", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    expect(harness.getNodes().every((item) => item.selected !== true)).toBe(true);

    // 第二根手指可能落在画布外（侧栏、工具条）：仍按规则 9.1 取消
    document.body.dispatchEvent(
      pointerEvent("pointerdown", { x: 10, y: 10, pointerId: 2, pointerType: "touch" }),
    );

    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("手势中失去按键（窗口外松开）取消并恢复选区", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    expect(harness.getNodes().every((item) => item.selected !== true)).toBe(true);

    harness.move({ x: 510, y: 500, buttons: 0 });

    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("松手前项目已切换：不把旧项目选区写入新项目", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    const writesAfterActivation = harness.setNodes.mock.calls.length;

    harness.setProjectId("p2");
    harness.release({ x: 500, y: 500 });

    // 激活时已清空旧选区；项目不匹配时不恢复、不提交，写入次数不再增加
    expect(harness.setNodes.mock.calls.length).toBe(writesAfterActivation);
    expect(harness.getNodes().every((item) => item.selected !== true)).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("丢失指针捕获取消手势并恢复选区", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    harness.pane.dispatchEvent(new Event("lostpointercapture"));

    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("鼠标右键抬起不结束进行中的手势", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    const callsAfterActivate = harness.setNodes.mock.calls.length;

    harness.release({ x: 500, y: 500, button: 2 });
    expect(harness.setNodes.mock.calls.length).toBe(callsAfterActivate);
    expect(harness.marquee.dataset.active).toBe("true");

    harness.release({ x: 500, y: 500 });
    expect(harness.setNodes).toHaveBeenCalledTimes(callsAfterActivate + 1);
    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
  });

  it("手势中按下右键不解除 click 抑制", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });
    const click = vi.fn();
    harness.pane.addEventListener("click", click);

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    // 左键按住期间按下右键：同一指针，忽略，不解除抑制
    harness.press({ x: 500, y: 500, button: 2 });
    harness.release({ x: 500, y: 500 });
    harness.session.syncRenderedNodes();

    harness.pane.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).not.toHaveBeenCalled();
  });

  it("右键菜单弹出时取消手势并恢复选区", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBeFalsy();

    window.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.getNodesSelectionActive()).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();

    // 取消后松手不再提交
    const callsAfterCancel = harness.setNodes.mock.calls.length;
    harness.release({ x: 500, y: 500 });
    expect(harness.setNodes.mock.calls.length).toBe(callsAfterCancel);
  });

  it("窗口失焦取消会话", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    window.dispatchEvent(new Event("blur"));

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.getNodes().find((item) => item.id === "a")?.selected).toBe(true);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
  });

  it("项目切换后取消但不把旧选区恢复到新项目", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0, { selected: true })],
      nodesSelectionActive: true,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    const callsBeforeSwitch = harness.setNodes.mock.calls.length;

    harness.setProjectId("p2");
    harness.session.syncRenderedNodes();

    // 只有激活时的清空；取消不再写回旧选区
    expect(harness.setNodes.mock.calls.length).toBe(callsBeforeSwitch);
    expect(harness.getNodesSelectionActive()).toBe(false);
    expect(harness.dispatchInteraction).toHaveBeenLastCalledWith("click");
    expect(harness.marquee.dataset.active).toBeUndefined();
  });

  it("提交后的 pane click 被抑制，下一次按下解除抑制", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });
    const click = vi.fn();
    harness.pane.addEventListener("click", click);

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });
    harness.release({ x: 500, y: 500 });
    harness.session.syncRenderedNodes();

    harness.pane.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).not.toHaveBeenCalled();

    // 下一次点击（未达阈值）正常派发
    harness.press({ x: 600, y: 300 });
    harness.release({ x: 600, y: 300 });
    harness.pane.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("按住空格时左键拖拽不启动框选", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true }));
  });

  it.each([
    { label: "触屏", pointerType: "touch" },
    { label: "未知指针", pointerType: "unknown" },
  ])("$label 指针不启动框选（规则 1.1）", ({ pointerType }) => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 50, y: 50, pointerType });
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();
  });

  it("手写笔正常启动框选（规则 1.1）", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 50, y: 50, pointerType: "pen" });
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBe("true");
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);
  });

  it.each([
    { label: "中键", init: { button: 1 } },
    { label: "非主指针", init: { isPrimary: false } },
  ])("$label 按下不启动框选（规则 1.1）", ({ init }) => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 50, y: 50, ...init });
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();
  });

  it("连线进行中（canStartMarquee=false）不启动框选（规则 1.1）", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0)],
      canStartMarquee: false,
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 500, y: 500 });

    expect(harness.marquee.dataset.active).toBeUndefined();
    expect(harness.setNodes).not.toHaveBeenCalled();
  });

  it("手势中节点变为不可选中：提交不选中它，也不激活聚合外框（规则 8.3）", () => {
    stubRaf();
    const harness = createHarness({
      nodes: [marqueeBox("a", 0, 0), marqueeBox("b", 400, 0)],
      edges: [edge("e1", "a", "b")],
    });

    harness.press({ x: 50, y: 50 });
    harness.move({ x: 150, y: 150 });
    expect(harness.wrappers.get("a")?.hasAttribute("data-marquee-hit")).toBe(true);

    // 冻结索引仍命中 a；提交按当前节点过滤 selectable，边跟随最终选中集
    harness.replaceNodes(
      harness.getNodes().map((node) => (node.id === "a" ? { ...node, selectable: false } : node)),
    );
    harness.release({ x: 150, y: 150 });

    expect(harness.getNodes().find((node) => node.id === "a")?.selected).toBeFalsy();
    expect(harness.getEdges().find((item) => item.id === "e1")?.selected).toBeFalsy();
    expect(harness.getNodesSelectionActive()).toBe(false);
    expect(harness.setNodesSelectionActive).not.toHaveBeenCalledWith(true);
  });

  it("靠近视口边缘时按 React Flow 同一公式自动平移", () => {
    stubRaf();
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });

    harness.press({ x: 400, y: 300 });
    harness.move({ x: 5, y: 300 });

    expect(harness.panBy).toHaveBeenCalled();
    const delta = harness.panBy.mock.calls[0][0] as { x: number; y: number };
    expect(delta.x).toBeCloseTo(13.125);
    expect(delta.y).toBe(0);
  });

  it("自动平移失败不终止手势，并保留诊断", async () => {
    stubRaf();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createHarness({ nodes: [marqueeBox("a", 0, 0)] });
    harness.panBy.mockImplementationOnce(() => Promise.reject(new Error("pan failed")));

    harness.press({ x: 400, y: 300 });
    harness.move({ x: 5, y: 300 });
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith("[marquee] 自动平移失败", expect.any(Error));
    expect(harness.marquee.dataset.active).toBe("true");
  });
});
