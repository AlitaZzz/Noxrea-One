/**
 * 保存链路安全网测试：stripRuntimeFields / takeCanvasSnapshot。
 *
 * 覆盖：
 *   - stripRuntimeFields 删除 selected / dragging / positionAbsolute
 *   - takeCanvasSnapshot 的深拷贝行为
 *   - 边界情况：空节点/边列表、缺失字段
 */

import { describe, it, expect } from "vitest";

// ════════════════════════════════════════════════════════════════════
// 测试辅助：匹配 save-manager.ts stripRuntimeFields 实现
// ════════════════════════════════════════════════════════════════════

interface HistorySnapshot {
  nodes: any[];
  edges: any[];
  viewport: { x: number; y: number; zoom: number };
  background: string;
  theme: string;
  minimapVisible: boolean;
  snapToGrid: boolean;
}

/**
 * 匹配 save-manager.ts L63-75 的 stripRuntimeFields。
 * 深拷贝 snapshot，从中剔除 React Flow 运行时字段。
 */
function stripRuntimeFields(snapshot: HistorySnapshot): HistorySnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((n: any) => {
      const { selected, dragging, positionAbsolute, ...rest } = n;
      return rest;
    }),
    edges: snapshot.edges.map((e: any) => {
      const { selected, ...rest } = e;
      return rest;
    }),
  };
}

/**
 * 匹配 canvas-store.ts L178-189 的 takeCanvasSnapshot。
 * 深拷贝 nodes/edges，浅拷贝其他字段。
 */
function takeCanvasSnapshot(state: {
  nodes: any[];
  edges: any[];
  viewport: { x: number; y: number; zoom: number };
  background: string;
  theme: string;
  minimapVisible: boolean;
  snapToGrid: boolean;
}): HistorySnapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)),
    edges: JSON.parse(JSON.stringify(state.edges)),
    viewport: { ...state.viewport },
    background: state.background,
    theme: state.theme,
    minimapVisible: state.minimapVisible,
    snapToGrid: state.snapToGrid,
  };
}

// ════════════════════════════════════════════════════════════════════
// stripRuntimeFields 测试
// ════════════════════════════════════════════════════════════════════

describe("stripRuntimeFields", () => {
  it("从节点中移除 selected / dragging / positionAbsolute", () => {
    const snapshot: HistorySnapshot = {
      nodes: [
        { id: "n1", type: "image-node", position: { x: 0, y: 0 }, data: { src: "a.png" }, selected: true, dragging: false, positionAbsolute: { x: 10, y: 20 } },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const cleaned = stripRuntimeFields(snapshot);
    expect(cleaned.nodes[0].id).toBe("n1");
    expect(cleaned.nodes[0]).not.toHaveProperty("selected");
    expect(cleaned.nodes[0]).not.toHaveProperty("dragging");
    expect(cleaned.nodes[0]).not.toHaveProperty("positionAbsolute");
    expect(cleaned.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(cleaned.nodes[0].data.src).toBe("a.png");
  });

  it("从边中移除 selected", () => {
    const snapshot: HistorySnapshot = {
      nodes: [],
      edges: [
        { id: "e1", source: "n1", target: "n2", selected: true, type: "deletable" },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const cleaned = stripRuntimeFields(snapshot);
    expect(cleaned.edges[0].id).toBe("e1");
    expect(cleaned.edges[0]).not.toHaveProperty("selected");
    expect(cleaned.edges[0].type).toBe("deletable");
  });

  it("保留非运行时字段", () => {
    const snapshot: HistorySnapshot = {
      nodes: [
        { id: "n1", position: { x: 100, y: 200 }, data: { label: "test" }, style: { width: 600 }, type: "text-node", selected: true },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", sourceHandle: "a", targetHandle: "b", selected: false, markerEnd: { type: "arrowclosed" } },
      ],
      viewport: { x: 50, y: 100, zoom: 1.5 },
      background: "grid",
      theme: "light",
      minimapVisible: false,
      snapToGrid: true,
    };

    const cleaned = stripRuntimeFields(snapshot);
    const node = cleaned.nodes[0];
    expect(node.id).toBe("n1");
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.data.label).toBe("test");
    expect(node.style).toEqual({ width: 600 });
    expect(node.type).toBe("text-node");

    const edge = cleaned.edges[0];
    expect(edge.source).toBe("n1");
    expect(edge.target).toBe("n2");
    expect(edge.sourceHandle).toBe("a");
    expect(edge.targetHandle).toBe("b");
    expect(edge.markerEnd).toEqual({ type: "arrowclosed" });
  });

  it("快照顶层字段保持不变", () => {
    const snapshot: HistorySnapshot = {
      nodes: [{ id: "n1", selected: true }],
      edges: [{ id: "e1", selected: true }],
      viewport: { x: -100, y: -200, zoom: 0.5 },
      background: "blank",
      theme: "dark",
      minimapVisible: false,
      snapToGrid: true,
    };

    const cleaned = stripRuntimeFields(snapshot);
    expect(cleaned.viewport).toEqual(snapshot.viewport);
    expect(cleaned.background).toBe("blank");
    expect(cleaned.theme).toBe("dark");
    expect(cleaned.minimapVisible).toBe(false);
    expect(cleaned.snapToGrid).toBe(true);
  });

  it("空节点/边列表不会出错", () => {
    const snapshot: HistorySnapshot = {
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const cleaned = stripRuntimeFields(snapshot);
    expect(cleaned.nodes).toEqual([]);
    expect(cleaned.edges).toEqual([]);
  });

  it("没有运行时字段的节点不会被改变", () => {
    const snapshot: HistorySnapshot = {
      nodes: [{ id: "n1", position: { x: 10, y: 20 }, data: {} }],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const cleaned = stripRuntimeFields(snapshot);
    expect(cleaned.nodes).toEqual([{ id: "n1", position: { x: 10, y: 20 }, data: {} }]);
    expect(cleaned.edges).toEqual([{ id: "e1", source: "n1", target: "n2" }]);
  });

  it("只移除 selected/dragging/positionAbsolute，保留其他布尔字段", () => {
    const snapshot: HistorySnapshot = {
      nodes: [
        { id: "n1", deletable: false, connectable: true, selected: true, dragging: false, positionAbsolute: { x: 1, y: 2 } },
      ],
      edges: [
        { id: "e1", deletable: true, selected: false },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const cleaned = stripRuntimeFields(snapshot);
    expect(cleaned.nodes[0].deletable).toBe(false);
    expect(cleaned.nodes[0].connectable).toBe(true);
    expect(cleaned.nodes[0]).not.toHaveProperty("selected");
    expect(cleaned.nodes[0]).not.toHaveProperty("dragging");
    expect(cleaned.nodes[0]).not.toHaveProperty("positionAbsolute");

    expect(cleaned.edges[0].deletable).toBe(true);
    expect(cleaned.edges[0]).not.toHaveProperty("selected");
  });
});

// ════════════════════════════════════════════════════════════════════
// takeCanvasSnapshot 测试
// ════════════════════════════════════════════════════════════════════

describe("takeCanvasSnapshot", () => {
  it("返回对象的 viewport/background/theme/minimapVisible/snapToGrid 字段正确", () => {
    const state = {
      nodes: [],
      edges: [],
      viewport: { x: -200, y: -300, zoom: 2 },
      background: "grid",
      theme: "light",
      minimapVisible: false,
      snapToGrid: true,
    };

    const snap = takeCanvasSnapshot(state);
    expect(snap.viewport).toEqual({ x: -200, y: -300, zoom: 2 });
    expect(snap.background).toBe("grid");
    expect(snap.theme).toBe("light");
    expect(snap.minimapVisible).toBe(false);
    expect(snap.snapToGrid).toBe(true);
  });

  it("nodes 和 edges 是深拷贝（修改副本不影响原数据）", () => {
    const originalNode = { id: "n1", data: { src: "a.png" } };
    const state = {
      nodes: [originalNode],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const snap = takeCanvasSnapshot(state);
    expect(snap.nodes).toEqual(state.nodes);
    expect(snap.edges).toEqual(state.edges);
    expect(snap.nodes).not.toBe(state.nodes);         // 不同数组
    expect(snap.nodes[0]).not.toBe(originalNode);      // 不同对象
    expect(snap.edges[0]).not.toBe(state.edges[0]);   // 不同对象
  });

  it("viewport 是浅拷贝（生产代码一致）", () => {
    const viewport = { x: 10, y: 20, zoom: 1 };
    const state = {
      nodes: [],
      edges: [],
      viewport,
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const snap = takeCanvasSnapshot(state);
    expect(snap.viewport).toEqual(viewport);
    // 浅拷贝意味着 snap.viewport !== viewport
    expect(snap.viewport).not.toBe(viewport);
  });

  it("深拷贝确保嵌套数据不被引用共享", () => {
    const data = { nested: { deep: true } };
    const state = {
      nodes: [{ id: "n1", data }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const snap = takeCanvasSnapshot(state);
    expect(snap.nodes[0].data.nested.deep).toBe(true);
    // 修改原数据不应影响快照
    data.nested.deep = false;
    expect(snap.nodes[0].data.nested.deep).toBe(true);
  });

  it("空状态的快照", () => {
    const state = {
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const snap = takeCanvasSnapshot(state);
    expect(snap.nodes).toEqual([]);
    expect(snap.edges).toEqual([]);
  });

  it("快照包含完整的节点数据（包括 style 等非必需字段）", () => {
    const state = {
      nodes: [{
        id: "n1", type: "image-node", position: { x: 100, y: 200 },
        data: { src: "http://img.png", naturalWidth: 800, naturalHeight: 600, label: "test" },
        style: { width: 480, height: 360 },
      }],
      edges: [{
        id: "e1", source: "n1", target: "n2", type: "deletable",
        markerEnd: { type: "arrowclosed", color: "#888" },
        style: { stroke: "#666" },
      }],
      viewport: { x: 0, y: 0, zoom: 1 },
      background: "dots",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const snap = takeCanvasSnapshot(state);
    expect(snap.nodes[0].style).toEqual({ width: 480, height: 360 });
    expect(snap.edges[0].markerEnd).toEqual({ type: "arrowclosed", color: "#888" });
  });
});

// ════════════════════════════════════════════════════════════════════
// 组合测试：stripRuntimeFields(takeCanvasSnapshot(state)) 行为
// ════════════════════════════════════════════════════════════════════

describe("stripRuntimeFields(takeCanvasSnapshot(state)) 完整管线", () => {
  it("生产中的实际调用顺序：快照 → 剥离运行时字段", () => {
    const state = {
      nodes: [
        { id: "n1", type: "image-node", position: { x: 100, y: 200 }, data: { src: "a.png" }, selected: true, dragging: false, positionAbsolute: { x: 100, y: 200 } },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", selected: false, type: "deletable" },
      ],
      viewport: { x: -50, y: -100, zoom: 1.5 },
      background: "grid",
      theme: "dark",
      minimapVisible: true,
      snapToGrid: false,
    };

    const snap = takeCanvasSnapshot(state);
    const clean = stripRuntimeFields(snap);

    // 深拷贝 + 剥离：修改原数据不应影响 cleaned
    state.nodes[0].data.src = "modified.png";
    state.edges[0].type = "straight";

    expect(clean.nodes[0].data.src).toBe("a.png");
    expect(clean.nodes[0]).not.toHaveProperty("selected");
    expect(clean.nodes[0]).not.toHaveProperty("dragging");
    expect(clean.edges[0].type).toBe("deletable"); // 原始值，没被修改影响
    expect(clean.edges[0]).not.toHaveProperty("selected");
    expect(clean.viewport).toEqual({ x: -50, y: -100, zoom: 1.5 });
  });
});
