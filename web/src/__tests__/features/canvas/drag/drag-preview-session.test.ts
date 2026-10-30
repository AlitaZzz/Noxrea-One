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

/** 吸附开启、网格关闭（步长 0）；总开关关闭见 SNAP_OFF */
const NO_GRID = { snapEnabled: true, snapGridSize: 0 };
const GRID = { snapEnabled: true, snapGridSize: 16 };
const SNAP_OFF = { snapEnabled: false, snapGridSize: 16 };

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

/** 固定 100×100 的盒，便于按锚点关系写出精确期望 */
const box = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): AnyNode =>
  node(id, x, y, { style: { width: 100, height: 100 }, ...extra });

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

const sessions: DragPreviewSession[] = [];

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
  sessions.push(session);
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
  // 修饰键监听挂在 window 上：不结束会话会跨用例泄漏事件
  for (const session of sessions.splice(0)) session.dispose();
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

    session.begin(["a"], NO_GRID);
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

    session.begin(["a"], NO_GRID);
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
    session.begin(["a"], NO_GRID, { preThresholdOffset: { x: 40, y: -20 } });
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
    session.begin(["a"], NO_GRID, { preThresholdOffset: { x: 40, y: 20 } });

    expect(el.style.translate).toBe("20px 10px");
    expect(session.isActive()).toBe(true);
  });

  it("补首帧后立即松手：按补偿后的位置提交", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })], 2);
    const { session, setNodes } = harness;

    session.begin(["a"], NO_GRID, { preThresholdOffset: { x: 40, y: 20 } });
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
    session.begin(["a"], GRID, { preThresholdOffset: { x: 10, y: 0 } });
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

    session.begin(["a"], GRID);
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();

    const previewGuides = getPreviewGuides();
    expect(previewGuides.some((g) => g.type === "vertical" && g.position === 200)).toBe(true);
    expect(previewGuides.some((g) => g.type === "horizontal" && g.position === 0)).toBe(true);

    session.commit([{ id: "a", position: { x: 197, y: 2 } }]);

    // 终态提交沿用同一会话状态与解析路径：stop 清理前辅助线与预览一致（规则 10.1）
    expect(getPreviewGuides()).toEqual(previewGuides);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 200, y: 0 });
  });

  it("吸附：无对齐参考时按网格取整", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, setNodes } = harness;

    session.begin(["a"], GRID);
    session.commit([{ id: "a", position: { x: 10, y: 10 } }]);

    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 16, y: 16 });
  });

  it("总开关关闭：不对齐、不取整、不画辅助线，落点等于原始位置", () => {
    stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 200, 0),
    ]);
    const { session, setNodes } = harness;

    session.begin(["a"], SNAP_OFF);
    session.commit([{ id: "a", position: { x: 197, y: 2 } }]);

    expect(getPreviewGuides()).toEqual([]);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 197, y: 2 });
  });

  it("多选拖动按并集盒吸附，同一偏移应用到所有拖动项", () => {
    const raf = stubRaf();
    const harness = createHarness([
      node("a", 0, 0, { selected: true }),
      node("b", 200, 0, { selected: true }),
      node("c", 400, 300),
    ]);
    const { session, setNodes } = harness;

    // 原始并集 [5,397] × [2,125]；c 左边缘 400 与并集右边缘差 3px
    session.begin(["a", "b"], NO_GRID);
    session.preview([
      { id: "a", position: { x: 197, y: 2 } },
      { id: "b", position: { x: 5, y: 5 } },
    ]);
    raf.flush();

    expect(getPreviewGuides()).toEqual([
      { type: "vertical", position: 400, start: 125, end: 300 },
    ]);

    session.commit([
      { id: "a", position: { x: 197, y: 2 } },
      { id: "b", position: { x: 5, y: 5 } },
    ]);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 200, y: 2 });
    expect(next.find((n) => n.id === "b")?.position).toEqual({ x: 8, y: 5 });
  });

  it("多选并集与单选同几何时吸附结果一致（规则 7.1、验收 3）", () => {
    const raf = stubRaf();

    // 单选：100×100 的 s 平移到 x=96，右侧 4px 内命中目标 t 的左边缘
    const single = createHarness([box("s", 0, 0), box("t", 200, 0)]);
    single.session.begin(["s"], NO_GRID);
    single.session.preview([{ id: "s", position: { x: 96, y: 0 } }]);
    raf.flush();
    const singleGuides = getPreviewGuides();
    single.session.commit([{ id: "s", position: { x: 96, y: 0 } }]);
    const singleNode = (single.setNodes.mock.calls[0][0] as AnyNode[]).find((n) => n.id === "s");

    // 多选：两个 50×100 首尾相接，并集与单选同几何、同一基准位移
    const multi = createHarness([
      node("a", 0, 0, { style: { width: 50, height: 100 } }),
      node("b", 50, 0, { style: { width: 50, height: 100 } }),
      box("t", 200, 0),
    ]);
    multi.session.begin(["a", "b"], NO_GRID);
    multi.session.preview([
      { id: "a", position: { x: 96, y: 0 } },
      { id: "b", position: { x: 146, y: 0 } },
    ]);
    raf.flush();
    expect(getPreviewGuides()).toEqual(singleGuides);

    multi.session.commit([
      { id: "a", position: { x: 96, y: 0 } },
      { id: "b", position: { x: 146, y: 0 } },
    ]);
    const multiNodes = multi.setNodes.mock.calls[0][0] as AnyNode[];
    expect(multiNodes.find((n) => n.id === "a")?.position.x).toBe(singleNode?.position.x);
    // b 的基准 x 比 a 大 50，吸附偏移与 a 相同
    expect((multiNodes.find((n) => n.id === "b")?.position.x ?? 0) - 50).toBe(
      singleNode?.position.x,
    );
  });

  it("组拖动：成员随组平移，提交只写组位置，释放后无残留偏移", () => {
    const raf = stubRaf();
    const member = node("m", 10, 10, { parentId: "g" });
    const harness = createHarness([group("g", 100, 100), member]);
    const { session, container, setNodes } = harness;
    const groupEl = addNodeEl(container, "g");
    const memberEl = addNodeEl(container, "m");

    session.begin(["g"], NO_GRID);
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
    session.begin(["m"], GRID);
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

    session.begin(["a", "b"], NO_GRID);
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

    session.begin(["a", "b"], NO_GRID);
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

    session.begin(["a", "b"], NO_GRID);
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

    session.begin(["a"], NO_GRID);
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

    session.begin(["a", "b"], NO_GRID);
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

    session.begin(["a"], NO_GRID);
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

    session.begin(["a"], NO_GRID);
    harness.writeStore([node("b", 300, 300)]);
    session.syncRenderedNodes();

    expect(session.isActive()).toBe(false);
    expect(el.style.translate).toBe("");
    expect(setNodes).not.toHaveBeenCalled();
  });

  it("外部写入重建时清空两轴锁定（规则 10.3）", () => {
    const raf = stubRaf();
    const harness = createHarness([box("a", 0, 0), box("t", 200, 0)]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_GRID);
    session.preview([{ id: "a", position: { x: 96, y: 0 } }]);
    raf.flush();
    // 右边缘 196 吸附到目标左边缘 200：位置 100，位移 100
    expect(el.style.translate).toBe("100px 0px");

    // 偏差 -8：在保持阈值内继续锁定，但已超出进入阈值
    session.preview([{ id: "a", position: { x: 108, y: 0 } }]);
    raf.flush();
    expect(el.style.translate).toBe("100px 0px");

    // 外部写入（新数组）触发重建：清空锁定后用最后一帧重算，-8 不再吸附
    harness.writeStore([box("a", 0, 0), box("t", 200, 0)]);
    session.syncRenderedNodes();
    expect(el.style.translate).toBe("108px 0px");

    session.preview([{ id: "a", position: { x: 108, y: 0 } }]);
    raf.flush();
    expect(el.style.translate).toBe("108px 0px");
    // X 轴未吸附：不产生竖向辅助线（Y 轴同高仍正常对齐）
    expect(getPreviewGuides().every((g) => g.type === "horizontal")).toBe(true);
  });

  it("外部写入重建保留修饰键状态（规则 10.3）", () => {
    const raf = stubRaf();
    const harness = createHarness([box("a", 0, 0), box("t", 200, 0)]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_GRID, { modifiers: { bypass: true, shift: false } });
    session.preview([{ id: "a", position: { x: 96, y: 0 } }]);
    raf.flush();
    // Ctrl/Meta 旁路：右边缘进入吸附范围也不吸附
    expect(el.style.translate).toBe("96px 0px");

    harness.writeStore([box("a", 0, 0), box("t", 200, 0)]);
    session.syncRenderedNodes();
    // 重建清空锁定但保留旁路：用最后一帧重算仍不吸附
    expect(el.style.translate).toBe("96px 0px");

    session.preview([{ id: "a", position: { x: 96, y: 0 } }]);
    raf.flush();
    expect(el.style.translate).toBe("96px 0px");
  });

  it("无终态帧时 stop 用最新未应用帧兜底提交", () => {
    stubRaf();
    const harness = createHarness([node("a", 0, 0, { selected: true })]);
    const { session, setNodes, markDirtyImmediate } = harness;

    session.begin(["a"], NO_GRID);
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

    session.begin(["a"], NO_GRID);
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

  it("滞回：锁定后 8px 内保持，超出后释放，回到 5px 内重新进入", () => {
    const raf = stubRaf();
    const harness = createHarness([
      box("a", 0, 0, { selected: true }),
      box("b", 200, 0),
    ]);
    const { session, container, setNodes } = harness;
    const el = addNodeEl(container, "a");
    const moveTo = (x: number) => {
      session.preview([{ id: "a", position: { x, y: 0 } }]);
      raf.flush();
    };

    session.begin(["a"], NO_GRID);

    // 进入：右边缘 196 与 b 左边缘 200 差 4px ≤ 5px
    moveTo(96);
    expect(el.style.translate).toBe("100px 0px");

    // 保持：偏差 -8px 仍在保持阈值内，落点不跳
    moveTo(108);
    expect(el.style.translate).toBe("100px 0px");

    // 释放：偏差 -8.5px 超过保持阈值，也超出进入阈值 → 原始位置
    moveTo(108.5);
    expect(el.style.translate).toBe("108.5px 0px");

    // 重新进入前 6px 仍不吸附，5px 时重新锁定
    moveTo(106);
    expect(el.style.translate).toBe("106px 0px");
    moveTo(105);
    expect(el.style.translate).toBe("100px 0px");

    // 提交沿用会话锁定状态；拖动结束清空辅助线
    session.commit([{ id: "a", position: { x: 105, y: 0 } }]);
    const next = setNodes.mock.calls[0][0] as AnyNode[];
    expect(next.find((n) => n.id === "a")?.position).toEqual({ x: 100, y: 0 });
    session.stop();
    expect(getPreviewGuides()).toEqual([]);
  });

  it("Ctrl 旁路：拖动中按下立即回到原始帧，松开后重新吸附", () => {
    const raf = stubRaf();
    const harness = createHarness([
      box("a", 0, 0, { selected: true }),
      box("b", 200, 0),
    ]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_GRID);
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();
    expect(el.style.translate).toBe("200px 0px");
    expect(getPreviewGuides().length).toBeGreaterThan(0);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(el.style.translate).toBe("197px 2px");
    expect(getPreviewGuides()).toEqual([]);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(el.style.translate).toBe("200px 0px");
    expect(getPreviewGuides().length).toBeGreaterThan(0);
  });

  it("Shift 轴限：只保留主导轴吸附，另一轴不吸附不画线", () => {
    const raf = stubRaf();
    const harness = createHarness([
      box("a", 0, 0, { selected: true }),
      box("b", 200, 0),
    ]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], GRID);
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();
    expect(el.style.translate).toBe("200px 0px");

    // 原始位移 x=197 > y=2 → 只吸附 X；Y 保持原始 2px
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
    expect(el.style.translate).toBe("200px 2px");
    expect(getPreviewGuides().some((g) => g.type === "vertical")).toBe(true);
    expect(getPreviewGuides().some((g) => g.type === "horizontal")).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    expect(el.style.translate).toBe("200px 0px");
    expect(getPreviewGuides().some((g) => g.type === "horizontal")).toBe(true);
  });

  it("窗口失焦清空全部修饰键并按最后一帧恢复吸附", () => {
    const raf = stubRaf();
    const harness = createHarness([
      box("a", 0, 0, { selected: true }),
      box("b", 200, 0),
    ]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_GRID);
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();
    expect(el.style.translate).toBe("200px 0px");

    // Ctrl 旁路 + Shift 轴限同时按下：原始位置、无辅助线
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, shiftKey: true }),
    );
    expect(el.style.translate).toBe("197px 2px");
    expect(getPreviewGuides()).toEqual([]);

    // 失焦必须同时清空旁路与轴限，而不是只清其一
    window.dispatchEvent(new Event("blur"));
    expect(el.style.translate).toBe("200px 0px");
    expect(getPreviewGuides().some((g) => g.type === "vertical")).toBe(true);
    expect(getPreviewGuides().some((g) => g.type === "horizontal")).toBe(true);
  });

  it("触屏拖动不响应修饰键：初值与键盘都不产生旁路（规则 8.5）", () => {
    const raf = stubRaf();
    const harness = createHarness([box("a", 0, 0), box("b", 200, 0)]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    // 初值带旁路与轴限也必须被忽略
    session.begin(["a"], NO_GRID, {
      touch: true,
      modifiers: { bypass: true, shift: true },
    });
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();
    expect(el.style.translate).toBe("200px 0px");

    // 未挂键盘监听：拖动中按 Ctrl/Shift 不改变预览
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, shiftKey: true }),
    );
    expect(el.style.translate).toBe("200px 0px");
  });

  it("非触屏拖动：开局按住的修饰键首帧即生效（异常表）", () => {
    const raf = stubRaf();

    // Ctrl 旁路：begin 传入的初值让首帧就不吸附
    const bypass = createHarness([box("a", 0, 0), box("b", 200, 0)]);
    const bypassEl = addNodeEl(bypass.container, "a");
    bypass.session.begin(["a"], NO_GRID, {
      modifiers: { bypass: true, shift: false },
    });
    bypass.session.preview([{ id: "a", position: { x: 196, y: 0 } }]);
    raf.flush();
    expect(bypassEl.style.translate).toBe("196px 0px");
    expect(getPreviewGuides()).toEqual([]);

    // Shift 轴限：首帧只吸附主导轴 X
    const axis = createHarness([box("a", 0, 0), box("b", 200, 0)]);
    const axisEl = addNodeEl(axis.container, "a");
    axis.session.begin(["a"], NO_GRID, {
      modifiers: { bypass: false, shift: true },
    });
    axis.session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();
    expect(axisEl.style.translate).toBe("200px 2px");
  });

  it("拖动组：组与成员都不成为吸附目标", () => {
    const raf = stubRaf();
    const harness = createHarness([
      group("g", 0, 0),
      node("m", 10, 10, { parentId: "g" }),
    ]);
    const { session, container } = harness;
    const gEl = addNodeEl(container, "g");
    const mEl = addNodeEl(container, "m");

    session.begin(["g"], NO_GRID);
    session.preview([{ id: "g", position: { x: 8, y: 2 } }]);
    raf.flush();

    // 若成员错误地留在目标集合，组会吸附到成员左上角 x=10
    expect(gEl.style.translate).toBe("8px 2px");
    expect(mEl.style.translate).toBe("8px 2px");
    expect(getPreviewGuides()).toEqual([]);
  });

  it("隐藏节点不参与吸附目标", () => {
    const raf = stubRaf();
    const harness = createHarness([
      box("a", 0, 0, { selected: true }),
      box("h", 200, 0, { hidden: true }),
    ]);
    const { session, container } = harness;
    const el = addNodeEl(container, "a");

    session.begin(["a"], NO_GRID);
    session.preview([{ id: "a", position: { x: 197, y: 2 } }]);
    raf.flush();

    expect(el.style.translate).toBe("197px 2px");
    expect(getPreviewGuides()).toEqual([]);
  });
});
