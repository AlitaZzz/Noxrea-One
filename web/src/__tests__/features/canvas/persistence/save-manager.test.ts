import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCanvasLease, setCanvasLease } from "@/features/canvas/persistence/canvas-lease";
import { saveManager } from "@/features/canvas/persistence/save-manager";
import { syncLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, CanvasData, GroupNode, ImageNode, TextNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  saveProjectDeltaRaw: vi.fn(),
  revision: 7,
}));

vi.mock("@/features/canvas/persistence/project-transport", () => ({
  saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  saveProjectDeltaRaw: (...args: unknown[]) => mocks.saveProjectDeltaRaw(...args),
}));

vi.mock("@/entities/project", () => ({
  getProjectRevision: () => mocks.revision,
  updateProjectRevision: (_id: string, revision: number) => { mocks.revision = revision; },
  runProjectWrite: <T,>(fn: () => Promise<T>) => fn(),
}));

function textNode(id: string): TextNode {
  return {
    id,
    type: NODE_TYPE.TEXT,
    position: { x: 100, y: 200 },
    data: { label: id, content: "", plainText: "" },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.revision = 7;
  mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
  mocks.saveProjectDeltaRaw.mockResolvedValue({ ok: true, status: 200 });
  saveManager.resetForProjectSwitch();
  setCanvasLease("p1", 42);
  useCanvasStore.getState().restoreFromProject("p1", {
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    minimapVisible: true, snapEnabled: false,
  });
});

afterEach(() => {
  saveManager.resetForProjectSwitch();
  clearCanvasLease("p1");
  clearCanvasLease("p2");
  vi.useRealTimers();
});

async function saveCanvas(): Promise<CanvasData> {
  saveManager.markDirty();
  await saveManager.flushAndWait();
  expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
  return (JSON.parse(mocks.saveProjectRaw.mock.calls[0][1] as string) as { canvasData: CanvasData }).canvasData;
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("SaveManager snapshot serialization", () => {
  it("卸载时跳过超出 keepalive 配额的画布请求", async () => {
    useCanvasStore.setState({
      nodes: [{
        ...textNode("large"),
        data: { ...textNode("large").data, plainText: "x".repeat(70 * 1024) },
      }],
    });

    saveManager.markDirty();
    saveManager.flushOnUnload();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
  });

  it("removes runtime fields and edge appearance without mutating canvas state", async () => {
    const node = {
      ...textNode("n1"),
      style: { width: 600, height: 366 },
      selected: true, dragging: true, positionAbsolute: { x: 100, y: 200 },
      measured: { width: 600, height: 366 }, resizing: true,
      deletable: false, connectable: true,
    };
    const edge: AnyEdge = {
      id: "e1", source: "n1", target: "n2", type: "deletable",
      sourceHandle: "output", targetHandle: "input", selected: true, deletable: false,
      data: { purpose: "reference" },
      style: { stroke: "var(--canvas-text-muted)", strokeWidth: 0, opacity: 0 },
      markerEnd: "arrow",
    };
    useCanvasStore.setState({ nodes: [node, textNode("n2")], edges: [edge] });
    const before = takeCanvasSnapshot();

    const saved = await saveCanvas();

    expect(saved.nodes[0]).toEqual({
      ...textNode("n1"), style: { width: 600, height: 366 }, deletable: false, connectable: true,
    });
    expect(saved.edges).toEqual([{
      id: "e1", source: "n1", target: "n2", type: "deletable",
      sourceHandle: "output", targetHandle: "input", deletable: false,
      data: { purpose: "reference" },
    }]);
    expect(takeCanvasSnapshot()).toEqual(before);
  });

  it("omits unresolved upload nodes and their incoming and outgoing edges", async () => {
    const failed: ImageNode = {
      id: "failed", type: NODE_TYPE.IMAGE, position: { x: 0, y: 0 },
      data: {
        label: "failed", src: "", lockAspectRatio: true, naturalWidth: 100, naturalHeight: 100,
        upload: { uploading: false, version: 1, error: { category: "unknown", message: "Upload failed", retryable: true } },
      },
    };
    useCanvasStore.setState({
      nodes: [textNode("n1"), failed, textNode("n2")],
      edges: [
        { id: "in", source: "n1", target: "failed" },
        { id: "out", source: "failed", target: "n2" },
        { id: "kept", source: "n1", target: "n2" },
      ],
    });

    const saved = await saveCanvas();

    expect(saved.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(saved.edges).toEqual([{ id: "kept", source: "n1", target: "n2" }]);
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
    expect(useCanvasStore.getState().edges).toHaveLength(3);
  });

  it("keeps an existing resource when a replacement upload fails", async () => {
    const image: ImageNode = {
      id: "image", type: NODE_TYPE.IMAGE, position: { x: 0, y: 0 },
      data: {
        label: "image", src: "/api/files/image.png", lockAspectRatio: true,
        naturalWidth: 100, naturalHeight: 100,
        upload: { uploading: false, version: 1, error: { category: "unknown", message: "Upload failed", retryable: true } },
      },
    };
    useCanvasStore.setState({
      nodes: [image, textNode("n2")],
      edges: [{ id: "e1", source: "image", target: "n2" }],
    });

    const saved = await saveCanvas();

    expect(saved.nodes).toEqual([image, textNode("n2")]);
    expect(saved.edges).toEqual([{ id: "e1", source: "image", target: "n2" }]);
  });

  it("saves empty canvas data and the latest viewport and settings", async () => {
    useCanvasStore.setState({ minimapVisible: false, snapEnabled: true, agentModel: "test-model" });
    const viewport = { x: -50, y: -100, zoom: 1.5 };
    syncLiveViewport(viewport);

    expect(await saveCanvas()).toEqual({
      nodes: [], edges: [], viewport, minimapVisible: false, snapEnabled: true, agentModel: "test-model",
    });
  });

  it("preserves parentId and relative coordinates through load, save and reload", async () => {
    const group: GroupNode = {
      id: "g1", type: NODE_TYPE.GROUP, position: { x: 10000, y: -3000 },
      data: { label: "Group" }, style: { width: 1000, height: 800 },
    };
    const child: TextNode = { ...textNode("n1"), parentId: group.id, position: { x: 40, y: 60 } };
    const nodes = [group, child, textNode("n2")];
    const edges = [{ id: "e1", type: "deletable", source: "n1", target: "n2" }];
    const original = structuredClone({ nodes, edges });
    useCanvasStore.getState().restoreFromProject("p1", { nodes, edges });

    const saved = await saveCanvas();
    expect(saved.nodes).toEqual(original.nodes);
    expect(saved.edges).toEqual(original.edges);

    useCanvasStore.getState().restoreFromProject("p1", saved);
    expect(takeCanvasSnapshot()).toMatchObject(original);
    expect({ nodes, edges }).toEqual(original);
  });
});

describe("画布增量保存", () => {
  it("整量 keepalive 超限时发送相对已落库基线的增量", async () => {
    const baseline = Array.from({ length: 100 }, (_, index) => ({
      ...textNode(`n${index}`),
      data: { ...textNode(`n${index}`).data, plainText: "x".repeat(900) },
    }));
    useCanvasStore.setState({ nodes: baseline });
    saveManager.setBaselineFromCurrent("p1");
    const changed = { ...baseline[0]!, data: { ...baseline[0]!.data, plainText: "changed" } };
    useCanvasStore.setState({ nodes: [changed, ...baseline.slice(1)] });

    saveManager.markDirty();
    saveManager.flushOnUnload();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect(mocks.saveProjectDeltaRaw).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mocks.saveProjectDeltaRaw.mock.calls[0]![1] as string) as {
      nodes: { upsert: Array<{ id: string }>; delete: string[] };
    };
    expect(body.nodes.upsert.map((node) => node.id)).toEqual(["n0"]);
    expect(body.nodes.delete).toEqual([]);
  });

  it("增量保存覆盖边增删和画布级设置差异", async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      ...textNode(`n${index}`),
      data: { ...textNode(`n${index}`).data, plainText: "x".repeat(900) },
    }));
    const oldEdge: AnyEdge = { id: "old", source: "n0", target: "n1" };
    useCanvasStore.setState({
      nodes,
      edges: [oldEdge],
      minimapVisible: true,
      snapEnabled: false,
      agentModel: "base-model",
    });
    syncLiveViewport({ x: 0, y: 0, zoom: 1 });
    saveManager.setBaselineFromCurrent("p1");

    const newEdge: AnyEdge = { id: "new", source: "n1", target: "n2" };
    useCanvasStore.setState({
      edges: [newEdge],
      minimapVisible: false,
      snapEnabled: true,
      agentModel: "next-model",
    });
    syncLiveViewport({ x: -80, y: 40, zoom: 1.25 });

    saveManager.markDirty();
    saveManager.flushOnUnload();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.saveProjectDeltaRaw).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mocks.saveProjectDeltaRaw.mock.calls[0]![1] as string) as {
      edges: { upsert: AnyEdge[]; delete: string[] };
      viewport: { x: number; y: number; zoom: number };
      minimapVisible: boolean;
      snapEnabled: boolean;
      agentModel: string;
    };
    expect(body.edges).toEqual({ upsert: [newEdge], delete: ["old"] });
    expect(body.viewport).toEqual({ x: -80, y: 40, zoom: 1.25 });
    expect(body.minimapVisible).toBe(false);
    expect(body.snapEnabled).toBe(true);
    expect(body.agentModel).toBe("next-model");
  });

  it("旧项目在途保存晚到时不覆盖新项目的卸载增量基线", async () => {
    const largeNodes = (prefix: string) =>
      Array.from({ length: 100 }, (_, index) => ({
        ...textNode(`${prefix}${index}`),
        data: { ...textNode(`${prefix}${index}`).data, plainText: "x".repeat(900) },
      }));

    const p1Nodes = largeNodes("p1-");
    useCanvasStore.setState({ nodes: p1Nodes });
    saveManager.setBaselineFromCurrent("p1");

    let resolveP1Save!: (value: unknown) => void;
    mocks.saveProjectRaw.mockReturnValueOnce(
      new Promise((resolve) => { resolveP1Save = resolve; })
    );
    saveManager.markDirty();
    saveManager.flushOnHide();
    await drainMicrotasks();
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);

    setCanvasLease("p2", 42);
    const p2Nodes = largeNodes("p2-");
    useCanvasStore.getState().restoreFromProject("p2", {
      nodes: p2Nodes,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      minimapVisible: true,
      snapEnabled: false,
    });
    saveManager.setBaselineFromCurrent("p2");

    resolveP1Save({ ok: true, status: 200 });
    await drainMicrotasks();

    const changed = { ...p2Nodes[0]!, data: { ...p2Nodes[0]!.data, plainText: "changed" } };
    useCanvasStore.setState({ nodes: [changed, ...p2Nodes.slice(1)] });
    saveManager.markDirty();
    saveManager.flushOnUnload();
    await drainMicrotasks();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
    expect(mocks.saveProjectDeltaRaw).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mocks.saveProjectDeltaRaw.mock.calls[0]![1] as string) as {
      nodes: { upsert: Array<{ id: string }> };
    };
    expect(body.nodes.upsert.map((node) => node.id)).toEqual(["p2-0"]);
  });
});

describe("takeCanvasSnapshot", () => {
  it("isolates nested node and edge data and appearance from subsequent edits", () => {
    const node: TextNode = {
      ...textNode("n1"), style: { width: 600, height: 366 },
      data: { ...textNode("n1").data, genSettings: {
        kind: "text", prompt: "before", modelKey: "model", refOrder: ["ref1"],
      } },
    };
    const edge = {
      id: "e1", source: "n1", target: "n2", data: { nested: { label: "before" } },
      style: { stroke: "#abcdef" },
    };
    useCanvasStore.setState({ nodes: [node], edges: [edge] });

    const snapshot = takeCanvasSnapshot();
    expect(snapshot.nodes[0]).toBe(node);
    expect(snapshot.edges[0]).toBe(edge);

    useCanvasStore.getState().updateNodeData("n1", {
      genSettings: { ...node.data.genSettings!, refOrder: ["ref1", "ref2"] },
    }, { width: 200, height: 366 }, { skipHistory: true });
    useCanvasStore.getState().setEdges([{ ...edge, data: { nested: { label: "after" } }, style: { stroke: "none" } }]);

    expect(snapshot.nodes[0].data).toMatchObject({ genSettings: { refOrder: ["ref1"] } });
    expect(snapshot.nodes[0].style).toEqual({ width: 600, height: 366 });
    expect(snapshot.edges[0].data).toEqual({ nested: { label: "before" } });
    expect(snapshot.edges[0].style).toEqual({ stroke: "#abcdef" });
  });

  it("captures the live viewport and settings without sharing viewport references", () => {
    const viewport = { x: -200, y: -300, zoom: 2 };
    syncLiveViewport(viewport);
    useCanvasStore.setState({ minimapVisible: false, snapEnabled: true });

    const snapshot = takeCanvasSnapshot();
    viewport.x = 500;

    expect(snapshot).toEqual({
      nodes: [], edges: [], viewport: { x: -200, y: -300, zoom: 2 },
      minimapVisible: false, snapEnabled: true,
    });
  });
});

describe("SaveManager 401 语义", () => {
  it("401 保留 dirty、暂停自动重试，下一次编辑携带原 baseRevision 重新保存", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    await saveManager.flushAndWait();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(mocks.saveProjectRaw.mock.calls[0]![1] as string) as { baseRevision: number };
    expect(firstBody.baseRevision).toBe(7);
    expect(mocks.revision).toBe(7);
    expect(warnSpy).toHaveBeenCalledWith("[SaveManager] save unauthorized; canvas changes stay dirty");

    // 401 后不排任何自动重试
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);

    // 新编辑解除暂停：同一份 dirty 内容重新保存
    saveManager.markDirty();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(mocks.saveProjectRaw.mock.calls[1]![1] as string) as { baseRevision: number };
    expect(secondBody.baseRevision).toBe(7);
    expect(mocks.revision).toBe(8);
    warnSpy.mockRestore();
  });

  it("flushOnHide 的 401 不走全局失效但保留 dirty，下次进入后台可重试", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    saveManager.flushOnHide();
    await drainMicrotasks();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
    expect(mocks.saveProjectRaw.mock.calls[0]![3]).toBe(true);
    expect(mocks.revision).toBe(7);

    // 仍处于 dirty：下一次 visibilitychange(hidden) 再尝试，成功后 revision 前进
    saveManager.flushOnHide();
    await drainMicrotasks();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
    expect(mocks.saveProjectRaw.mock.calls[1]![3]).toBe(true);
    expect(mocks.revision).toBe(8);
    warnSpy.mockRestore();
  });

  it("flushOnUnload 的 401 保留 dirty 并走 keepalive，下次卸载前兜底可重试", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    saveManager.flushOnUnload();
    await drainMicrotasks();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
    expect(mocks.saveProjectRaw.mock.calls[0]![2]).toBe(true);
    expect(mocks.saveProjectRaw.mock.calls[0]![3]).toBe(true);
    expect(mocks.revision).toBe(7);

    // dirty 仍在：pagehide 再次触发时携带原 baseRevision 重试，成功后 revision 前进
    saveManager.flushOnUnload();
    await drainMicrotasks();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(mocks.saveProjectRaw.mock.calls[1]![1] as string) as { baseRevision: number };
    expect(secondBody.baseRevision).toBe(7);
    expect(mocks.revision).toBe(8);
    warnSpy.mockRestore();
  });

  it("flushAndWait 的 401 立即收敛，再次 flushAndWait 重试成功后 revision 前进", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    await saveManager.flushAndWait();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
    expect(mocks.revision).toBe(7);

    // 第二次显式 flush 是恢复时机：清除 authBlocked 后重发同一份 dirty
    await saveManager.flushAndWait();

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(mocks.saveProjectRaw.mock.calls[1]![1] as string) as { baseRevision: number };
    expect(secondBody.baseRevision).toBe(7);
    expect(mocks.revision).toBe(8);
    warnSpy.mockRestore();
  });

  it("握手采纳快照后解除 401 暂停，下一次编辑保存成功", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    await saveManager.flushAndWait();
    expect(mocks.revision).toBe(7);

    // 新会话握手成功：以服务端快照重建基线并解除暂停
    saveManager.setBaselineFromCurrent("p1");
    saveManager.markDirty();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
    expect(mocks.revision).toBe(8);
    warnSpy.mockRestore();
  });
});
