/**
 * 画布自定义事件 handler 行为测试。
 *
 * 测试 handler 函数的逻辑（store 调用参数、边界情况），
 * 不依赖 jsdom/DOM 事件分发。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Handler 逻辑提取为纯函数 ────────────────────────────────

/** canvas:copy-node handler */
function handleCopyNode(
  detail: { nodeId?: string },
  nodes: { id: string }[],
  copySelected: (targets: any[]) => void,
) {
  const target = nodes.find((n) => n.id === detail.nodeId);
  if (target) copySelected([target]);
}

/** canvas:delete-nodes handler */
function handleDeleteNodes(
  detail: { nodeIds?: string[] },
  pushHistory: () => void,
  removeNodes: (ids: string[]) => void,
) {
  pushHistory();
  removeNodes(detail.nodeIds || []);
}

/** canvas:delete-edges handler */
function handleDeleteEdges(
  detail: { edgeIds?: string[] },
  pushHistory: () => void,
  removeEdges: (ids: string[]) => void,
) {
  pushHistory();
  removeEdges(detail.edgeIds || []);
}

/** node:update-data handler */
function handleUpdateData(
  detail: { nodeId?: string; data?: any; style?: any; position?: any; immediate?: boolean },
  updateNodeData: (id: string, data: any, style?: any) => void,
  markDirty: () => void,
  markDirtyImmediate: () => void,
  getState: () => { nodes: any[]; setNodes: (ns: any[]) => void },
) {
  const { nodeId, data, style, position, immediate } = detail;
  if (position) {
    const s = getState();
    s.setNodes(
      s.nodes.map((n: any) =>
        n.id === nodeId ? { ...n, position } : n
      )
    );
    markDirty();
  }
  updateNodeData(nodeId || "", data ?? {}, style);
  if (immediate) markDirtyImmediate();
}

// ── Tests ──────────────────────────────────────────────────────

describe("canvas:copy-node handler", () => {
  it("calls copySelected with matching node", () => {
    const copySelected = vi.fn();
    const nodes = [
      { id: "n1", type: "image-node" },
      { id: "n2", type: "text-node" },
    ];
    handleCopyNode({ nodeId: "n1" }, nodes, copySelected);
    expect(copySelected).toHaveBeenCalledWith([nodes[0]]);
  });

  it("does nothing for non-existent node", () => {
    const copySelected = vi.fn();
    handleCopyNode({ nodeId: "missing" }, [], copySelected);
    expect(copySelected).not.toHaveBeenCalled();
  });

  it("does nothing when nodeId missing", () => {
    const copySelected = vi.fn();
    handleCopyNode({}, [], copySelected);
    expect(copySelected).not.toHaveBeenCalled();
  });
});

describe("canvas:delete-nodes handler", () => {
  it("removes specified nodes", () => {
    const pushHistory = vi.fn();
    const removeNodes = vi.fn();
    handleDeleteNodes({ nodeIds: ["n1", "n2"] }, pushHistory, removeNodes);
    expect(pushHistory).toHaveBeenCalledOnce();
    expect(removeNodes).toHaveBeenCalledWith(["n1", "n2"]);
  });

  it("handles missing nodeIds gracefully", () => {
    const pushHistory = vi.fn();
    const removeNodes = vi.fn();
    handleDeleteNodes({}, pushHistory, removeNodes);
    expect(removeNodes).toHaveBeenCalledWith([]);
  });
});

describe("canvas:delete-edges handler", () => {
  it("removes specified edges", () => {
    const pushHistory = vi.fn();
    const removeEdges = vi.fn();
    handleDeleteEdges({ edgeIds: ["e1"] }, pushHistory, removeEdges);
    expect(pushHistory).toHaveBeenCalledOnce();
    expect(removeEdges).toHaveBeenCalledWith(["e1"]);
  });
});

describe("node:update-data handler", () => {
  it("updates node data", () => {
    const updateNodeData = vi.fn();
    handleUpdateData(
      { nodeId: "n1", data: { label: "new" } },
      updateNodeData, vi.fn(), vi.fn(),
      () => ({ nodes: [], setNodes: vi.fn() }),
    );
    expect(updateNodeData).toHaveBeenCalledWith("n1", { label: "new" }, undefined);
  });

  it("calls markDirtyImmediate when immediate=true", () => {
    const markDirtyImmediate = vi.fn();
    handleUpdateData(
      { nodeId: "n1", data: {}, immediate: true },
      vi.fn(), vi.fn(), markDirtyImmediate,
      () => ({ nodes: [], setNodes: vi.fn() }),
    );
    expect(markDirtyImmediate).toHaveBeenCalled();
  });

  it("updates position when position in detail", () => {
    const markDirty = vi.fn();
    const setNodes = vi.fn();
    handleUpdateData(
      { nodeId: "n1", position: { x: 300, y: 400 } },
      vi.fn(), markDirty, vi.fn(),
      () => ({ nodes: [{ id: "n1", position: { x: 100, y: 200 } }], setNodes }),
    );
    expect(setNodes).toHaveBeenCalled();
    expect(markDirty).toHaveBeenCalled();
  });

  it("position update filters by nodeId", () => {
    const setNodes = vi.fn();
    handleUpdateData(
      { nodeId: "target", position: { x: 999, y: 999 } },
      vi.fn(), vi.fn(), vi.fn(),
      () => ({
        nodes: [
          { id: "target", position: { x: 0, y: 0 } },
          { id: "other", position: { x: 100, y: 100 } },
        ],
        setNodes,
      }),
    );
    const updated = setNodes.mock.calls[0][0];
    expect(updated.find((n: any) => n.id === "target").position).toEqual({ x: 999, y: 999 });
    expect(updated.find((n: any) => n.id === "other").position).toEqual({ x: 100, y: 100 });
  });
});
