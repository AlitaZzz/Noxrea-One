// @vitest-environment jsdom
import { Position } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DragPreviewSession } from "@/features/canvas/drag/drag-preview-session";
import {
  registerEdgeGeometry,
  unregisterEdgeGeometry,
} from "@/features/canvas/drag/edge-geometry-registry";
import {
  clearPreviewGuides,
  getPreviewGuides,
} from "@/features/canvas/drag/preview-guides";
import { computeEdgePath } from "@/features/canvas/shared/edge-geometry";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

const NO_SNAP = { snapToGrid: false, snapGridSize: 16, snapThreshold: 5 };
const SNAP = { snapToGrid: true, snapGridSize: 16, snapThreshold: 5 };

const node = (
  id: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): AnyNode =>
  ({
    id,
    type: NODE_TYPE.TEXT,
    position: { x, y },
    data: {},
    selected: false,
    ...extra,
  }) as unknown as AnyNode;

const group = (id: string, x: number, y: number): AnyNode =>
  node(id, x, y, { type: NODE_TYPE.GROUP, selected: true });

/** 手动推进 rAF：会话每帧最多写一次 DOM，测试逐帧断言 */
function stubRaf() {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  return {
    flush() {
      const pending = [...queue.values()];
      queue.clear();
      for (const cb of pending) cb(0);
    },
    pending: () => queue.size,
  };
}

function createHarness(nodes: AnyNode[], zoom = 1) {
  let store = nodes;
  const setNodes = vi.fn((next: AnyNode[]) => {
    store = next;
  });
  const markDirtyImmediate = vi.fn();
  const container = document.createElement("div");
  const session = new DragPreviewSession({
    root: { current: container },
    getNodes: () => store,
    setNodes,
    markDirtyImmediate,
    getZoom: () => zoom,
  });
  return {
    session,
    container,
    setNodes,
    markDirtyImmediate,
    getStore: () => store,
    writeStore: (next: AnyNode[]) => {
      store = next;
    },
  };
}

function addNodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "react-flow__node";
  el.dataset.id = id;
  container.appendChild(el);
  return el;
}

function addEdgeEl(container: HTMLElement, id: string): SVGGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "g");
  el.setAttribute("class", "react-flow__edge");
  el.dataset.id = id;
  for (const className of ["", "react-flow__edge-path"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (className) path.setAttribute("class", className);
    path.setAttribute("d", "M0 0");
    el.appendChild(path);
  }
  container.appendChild(el);
  return el;
}

const edgeGeometry = (sourceId: string, targetId: string) => ({
  sourceId,
  targetId,
  sourceX: 200,
  sourceY: 60,
  targetX: 400,
  targetY: 60,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
});

const registeredEdges: string[] = [];

function registerEdge(id: string, sourceId: string, targetId: string) {
  registerEdgeGeometry(id, edgeGeometry(sourceId, targetId));
  registeredEdges.push(id);
}

beforeEach(() => {
  clearPreviewGuides();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const id of registeredEdges.splice(0)) unregisterEdgeGeometry(id);
  clearPreviewGuides();
});

describe("DragPreviewSession", () => {
  it("预览帧不写 store，终态帧恰好提交一次并立即落库", () => {
    const raf = stubRaf();
    const other = node("b", 300, 300);
    const harness = createHarness([node("a", 0, 0, { selected: true }), other]);
    const { session, setNodes, markDirtyImmediate } = harness;

    session.begin(["a"], NO_SNAP);
    session.preview([{ id: "a", position: { x: 20, y: 10 } }]);
    raf.flush();
    session.preview([{ id: "a", position: { x: 30, y: 10 } }]);
    raf.flush();

    expect(setNodes).not.toHaveBeenCalled();
    expect(markDirtyImmediate).not.toHaveBeenCalled();

    session.commit([{ id: "a", position: { x: 40, y: 10 } }]);

    expect(setNodes).toHaveBeenCalledTimes(1);
    expect(markDirtyImmediate).toHaveBeenCalledTimes(1);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 40, y: 10 });
    // 非拖动节点保持原引用，提交只替换拖动项
    expect(next.find((n) => n.id === "b")).toBe(other);
  });

  it("终态位置未变化时不写 store、不落库，立即结束会话", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, setNodes, markDirtyImmediate } = harness;

    session.begin(["a"], NO_SNAP);
    session.commit([{ id: "a", position: { x: 0, y: 0 } }]);

    expect(setNodes).not.toHaveBeenCalled();
    expect(markDirtyImmediate).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(false);
  });

  it("阈值前指针位移补偿：预览与提交按屏幕位移 ÷ zoom 平移", () => {
    const raf = stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })], 2);
    const { session, container, setNodes } = harness;
    const el = addNodeEl(container, "a");

    // 按下点到阈值事件点指针移动 (40,-20) 屏幕 px，zoom = 2 → 画布位移 (20,-10)
    session.begin(["a"], NO_SNAP, { x: 40, y: -20 });
    session.preview([{ id: "a", position: { x: 10, y: 0 } }]);
    raf.flush();

    expect(el.style.translate).toBe("30px -10px");

    session.commit([{ id: "a", position: { x: 10, y: 0 } }]);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next[0].position).toEqual({ x: 30, y: -10 });
  });

  it("阈值事件补首帧：起手当帧按参考点补偿落位，不等下一次移动", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })], 2);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    // 无 preview 调用：begin 自身补出首帧（规则 2.8）
    session.begin(["a"], NO_SNAP, { x: 40, y: 20 });

    expect(el.style.translate).toBe("20px 10px");
    expect(session.isActive()).toBe(true);
  });

  it("补首帧后立即松手：按补偿后的位置提交", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })], 2);
    const { session, setNodes } = harness;

    session.begin(["a"], NO_SNAP, { x: 40, y: 20 });
    session.stop();

    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next[0].position).toEqual({ x: 20, y: 10 });
  });

  it("阈值前位移补偿先于吸附：补偿后的位置参与对齐判定", () => {
    stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 200, 0),
    ]);
    const { session, setNodes } = harness;

    // 补偿前 x = 187，补 10 后 197 与 b 左边缘差 3px（阈值内）→ 吸附到 200
    session.begin(["a"], SNAP, { x: 10, y: 0 });
    session.commit([{ id: "a", position: { x: 187, y: 0 } }]);

    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 200, y: 0 });
  });

  it("吸附：单选按对齐参考吸附并发布辅助线，提交写吸附后位置", () => {
    const raf = stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 200, 0),
    ]);
    const { session, setNodes } = harness;

    session.begin(["a"], SNAP);
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();

    const guides = getPreviewGuides();
    expect(guides.some((g) => g.type === "vertical" && g.position === 200)).toBe(true);
    expect(guides.some((g) => g.type === "horizontal" && g.position === 0)).toBe(true);

    session.commit([{ id: "a", position: { x: 197, y: 2 } }]);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 200, y: 0 });
  });

  it("吸附：无对齐参考时按网格取整", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, setNodes } = harness;

    session.begin(["a"], SNAP);
    session.commit([{ id: "a", position: { x: 10, y: 10 } }]);

    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 16, y: 16 });
  });

  it("多选拖动不吸附，按原始帧提交", () => {
    stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 200, 0, { selected: true }),
    ]);
    const { session, setNodes } = harness;

    session.begin(["a", "b"], SNAP);
    session.commit([
      { id: "a", position: { x: 197, y: 2 } },
      { id: "b", position: { x: 5, y: 5 } },
    ]);

    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 197, y: 2 });
    expect(next.find((n) => n.id === "b")?.position).toEqual({ x: 5, y: 5 });
  });

  it("组拖动：成员随组平移，提交只写组位置，释放后无残留偏移", () => {
    const raf = stubRaf();
    const member = node("m", 10, 10, { parentId: "g" });
    const harness = createHarness([group("g", 100, 100), member]);
    const { session, container, setNodes } = harness;
    const groupEl = addNodeEl(container, "g");
    const memberEl = addNodeEl(container, "m");

    session.begin(["g"], NO_SNAP);
    session.preview([{ id: "g", position: { x: 150, y: 100 } }]);
    raf.flush();

    expect(groupEl.style.translate).toBe("50px 0px");
    expect(memberEl.style.translate).toBe("50px 0px");

    session.commit([{ id: "g", position: { x: 150, y: 100 } }]);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "g")?.position).toEqual({ x: 150, y: 100 });
    expect(next.find((n) => n.id === "m")).toBe(member);

    // 渲染层采用新位置后释放预览偏移
    session.syncRenderedNodes();
    expect(groupEl.style.translate).toBe("");
    expect(memberEl.style.translate).toBe("");
    expect(session.isActive()).toBe(false);
  });

  it("组内成员单选拖动按绝对坐标吸附，提交写回相对位置", () => {
    stubRaf();
    const harness = createHarness([
      node("g", 100, 1000, { type: NODE_TYPE.GROUP }),
      node("m", 10, 10, { parentId: "g", selected: true }),
      node("x", 508, 1018),
    ]);
    const { session, setNodes } = harness;

    // 原始相对位置 (410,20) → 绝对 (510,1020)，与 x 左/上边各差 2px → 吸附到 (508,1018)
    session.begin(["m"], SNAP);
    session.commit([{ id: "m", position: { x: 410, y: 20 } }]);

    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "m")?.position).toEqual({ x: 408, y: 18 });
  });

  it("同位移边整体平移，混合位移边按预览端点重算路径", () => {
    const raf = stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 400, 0, { selected: true }),
      node("c", 0, 400),
    ]);
    const { session, container } = harness;
    addNodeEl(container, "a");
    addNodeEl(container, "b");
    addEdgeEl(container, "e1");
    addEdgeEl(container, "e2");
    registerEdge("e1", "a", "b");
    registerEdge("e2", "a", "c");
    const e1 = container.querySelector<SVGGElement>('.react-flow__edge[data-id="e1"]')!;
    const e2 = container.querySelector<SVGGElement>('.react-flow__edge[data-id="e2"]')!;

    session.begin(["a", "b"], NO_SNAP);
    session.preview([
      { id: "a", position: { x: 10, y: 0 } },
      { id: "b", position: { x: 410, y: 0 } },
    ]);
    raf.flush();

    // e1 两端同位移：整条边平移，不改路径
    expect(e1.style.translate).toBe("10px 0px");
    for (const path of e1.querySelectorAll("path")) {
      expect(path.getAttribute("d")).toBe("M0 0");
    }
    // e2 仅源端受影响：按预览端点重算，与 DeletableEdge 共用同一几何函数
    const expected = computeEdgePath({ ...edgeGeometry("a", "c"), sourceX: 210 }).path;
    for (const path of e2.querySelectorAll("path")) {
      expect(path.getAttribute("d")).toBe(expected);
    }
  });

  it("路径模式切回平移模式时按登记几何还原基准路径", () => {
    const raf = stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 400, 0, { selected: true }),
    ]);
    const { session, container } = harness;
    addNodeEl(container, "a");
    addNodeEl(container, "b");
    addEdgeEl(container, "e1");
    registerEdge("e1", "a", "b");
    const edge = container.querySelector<SVGGElement>('.react-flow__edge[data-id="e1"]')!;

    session.begin(["a", "b"], NO_SNAP);
    session.preview([
      { id: "a", position: { x: 10, y: 0 } },
      { id: "b", position: { x: 400, y: 0 } },
    ]);
    raf.flush();
    const previewD = computeEdgePath({ ...edgeGeometry("a", "b"), sourceX: 210 }).path;
    expect(edge.querySelector("path")?.getAttribute("d")).toBe(previewD);

    session.preview([
      { id: "a", position: { x: 10, y: 0 } },
      { id: "b", position: { x: 410, y: 0 } },
    ]);
    raf.flush();

    expect(edge.style.translate).toBe("10px 0px");
    const baseD = computeEdgePath(edgeGeometry("a", "b")).path;
    for (const path of edge.querySelectorAll("path")) {
      expect(path.getAttribute("d")).toBe(baseD);
    }
  });

  it("受影响端点移出会话的边还原基准路径，不保留陈旧预览", () => {
    const raf = stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 400, 0, { selected: true }),
    ]);
    const { session, container } = harness;
    addNodeEl(container, "a");
    addNodeEl(container, "b");
    addEdgeEl(container, "e1");
    registerEdge("e1", "a", "b");
    const edge = container.querySelector<SVGGElement>('.react-flow__edge[data-id="e1"]')!;

    session.begin(["a", "b"], NO_SNAP);
    session.preview([
      { id: "a", position: { x: 10, y: 0 } },
      { id: "b", position: { x: 400, y: 0 } },
    ]);
    raf.flush();
    expect(edge.style.translate).toBe("");

    // 目标端不再出现在帧里：该边回到基准几何，不展示上一帧的陈旧路径
    session.preview([{ id: "a", position: { x: 20, y: 0 } }]);
    raf.flush();

    const baseD = computeEdgePath(edgeGeometry("a", "b")).path;
    for (const path of edge.querySelectorAll("path")) {
      expect(path.getAttribute("d")).toBe(baseD);
    }
    expect(edge.style.translate).toBe("");
  });

  it("边标签层拖动期隐藏，提交并释放后恢复", () => {
    const raf = stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, container } = harness;
    addNodeEl(container, "a");
    const labelLayer = document.createElement("div");
    labelLayer.className = "react-flow__edgelabel-renderer";
    container.appendChild(labelLayer);

    session.begin(["a"], NO_SNAP);
    expect(labelLayer.style.visibility).toBe("hidden");

    session.preview([{ id: "a", position: { x: 10, y: 0 } }]);
    raf.flush();
    expect(labelLayer.style.visibility).toBe("hidden");

    session.commit([{ id: "a", position: { x: 10, y: 0 } }]);
    session.syncRenderedNodes();
    expect(labelLayer.style.visibility).toBe("");
  });

  it("选中框与工具条按屏幕空间跟随，混合位移时隐藏；批量轨道不写 DOM", () => {
    const raf = stubRaf();
    const harness = createHarness(
      [
        node("a", 0, 0, { selected: true }),
        node("b", 400, 0, { selected: true }),
      ],
      2,
    );
    const { session, container } = harness;
    addNodeEl(container, "a");
    addNodeEl(container, "b");
    const frame = document.createElement("div");
    frame.className = "react-flow__nodesselection";
    container.appendChild(frame);
    const rail = document.createElement("div");
    rail.className = "batch-connect-handle";
    container.appendChild(rail);
    const toolbar = document.createElement("div");
    toolbar.className = "react-flow__node-toolbar";
    toolbar.dataset.id = "a";
    container.appendChild(toolbar);

    session.begin(["a", "b"], NO_SNAP);
    session.preview([
      { id: "a", position: { x: 10, y: 0 } },
      { id: "b", position: { x: 400, y: 5 } },
    ]);
    raf.flush();

    // 位移混合：选中框隐藏，工具条各自跟随；批量轨道拖动期由容器
    // data-interaction 的 CSS 规则整体隐藏，会话不写它的 visibility/translate
    expect(frame.style.visibility).toBe("hidden");
    expect(rail.style.visibility).toBe("");
    expect(rail.style.translate).toBe("");
    expect(toolbar.style.translate).toBe("20px 0px");

    session.preview([
      { id: "a", position: { x: 10, y: 0 } },
      { id: "b", position: { x: 410, y: 0 } },
    ]);
    raf.flush();

    // 位移一致（zoom = 2）：选中框与工具条按屏幕空间换算；轨道仍不被会话接管
    expect(frame.style.visibility).toBe("");
    expect(frame.style.translate).toBe("20px 0px");
    expect(rail.style.visibility).toBe("");
    expect(rail.style.translate).toBe("");
    expect(toolbar.style.translate).toBe("20px 0px");
  });

  it("外部写入：以新 store 重建基准，无重复位移，取消后无残留", () => {
    const raf = stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, container, setNodes } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_SNAP);
    session.preview([{ id: "a", position: { x: 10, y: 0 } }]);
    raf.flush();
    expect(el.style.translate).toBe("10px 0px");

    // 撤销/回填：store 被外部改写为新数组，渲染层采用后会话按新基准重建
    harness.writeStore([node("a", 100, 0, { selected: true })]);
    session.syncRenderedNodes();

    expect(setNodes).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(true);
    expect(el.style.translate).toBe("-90px 0px");

    session.cancel();
    expect(el.style.translate).toBe("");
    expect(setNodes).not.toHaveBeenCalled();
    expect(harness.getStore()[0].position).toEqual({ x: 100, y: 0 });
  });

  it("拖动中拖动项被删除时退出会话且不写 store", () => {
    stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 300, 300),
    ]);
    const { session, container, setNodes } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_SNAP);
    harness.writeStore([node("b", 300, 300)]);
    session.syncRenderedNodes();

    expect(session.isActive()).toBe(false);
    expect(el.style.translate).toBe("");
    expect(setNodes).not.toHaveBeenCalled();
  });

  it("无终态帧时 stop 用最新未应用帧兜底提交", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, setNodes, markDirtyImmediate } = harness;

    session.begin(["a"], NO_SNAP);
    // 帧已排入 rAF 但尚未执行：兜底提交必须用它，不能退回更旧的已应用帧
    session.preview([{ id: "a", position: { x: 20, y: 0 } }]);
    session.stop();

    expect(setNodes).toHaveBeenCalledTimes(1);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next[0].position).toEqual({ x: 20, y: 0 });
    expect(markDirtyImmediate).toHaveBeenCalledTimes(1);
  });

  it("卸载取消：无残留偏移与隐藏层，store 未写入", () => {
    const raf = stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, container, setNodes } = harness;
    const el = addNodeEl(container, "a");
    const labelLayer = document.createElement("div");
    labelLayer.className = "react-flow__edgelabel-renderer";
    container.appendChild(labelLayer);

    session.begin(["a"], NO_SNAP);
    session.preview([{ id: "a", position: { x: 10, y: 0 } }]);
    raf.flush();
    expect(el.style.translate).toBe("10px 0px");
    expect(labelLayer.style.visibility).toBe("hidden");

    session.dispose();

    expect(el.style.translate).toBe("");
    expect(labelLayer.style.visibility).toBe("");
    expect(getPreviewGuides()).toEqual([]);
    expect(setNodes).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(false);
  });
});
