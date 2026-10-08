import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, GroupNode, ImageNode, TextNode } from "@/features/canvas/types";
import { resetCanvasLease, setCanvasLease } from "@/features/project/canvas-lease";
import { saveManager } from "@/features/project/save-manager";
import type { CanvasData } from "@/features/project/types";
import { NODE_TYPE } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  revision: 7,
}));

vi.mock("@/features/project/api", () => ({
  projectApi: { saveProjectRaw: mocks.saveProjectRaw },
}));

vi.mock("@/features/project/store", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "p1", revision: mocks.revision }],
      updateProjectRevision: (_id: string, revision: number) => { mocks.revision = revision; },
    }),
  },
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
  saveManager.resetForProjectSwitch();
  resetCanvasLease();
  setCanvasLease("p1", 42);
  useCanvasStore.getState().restoreFromProject("p1", {
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    minimapVisible: true, snapToGrid: false,
  });
});

afterEach(() => {
  saveManager.resetForProjectSwitch();
  resetCanvasLease();
  vi.useRealTimers();
});

async function saveCanvas(): Promise<CanvasData> {
  saveManager.markDirty();
  await saveManager.flushAndWait();
  expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
  return (JSON.parse(mocks.saveProjectRaw.mock.calls[0][1] as string) as { canvasData: CanvasData }).canvasData;
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
    useCanvasStore.setState({ minimapVisible: false, snapToGrid: true, agentModel: "test-model" });
    const viewport = { x: -50, y: -100, zoom: 1.5 };
    syncLiveViewport(viewport);

    expect(await saveCanvas()).toEqual({
      nodes: [], edges: [], viewport, minimapVisible: false, snapToGrid: true, agentModel: "test-model",
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
    useCanvasStore.setState({ minimapVisible: false, snapToGrid: true });

    const snapshot = takeCanvasSnapshot();
    viewport.x = 500;

    expect(snapshot).toEqual({
      nodes: [], edges: [], viewport: { x: -200, y: -300, zoom: 2 },
      minimapVisible: false, snapToGrid: true,
    });
  });
});
