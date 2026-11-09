// @vitest-environment jsdom
/**
 * 编组/取消编组归属变换与组内布局动作测试。
 * - 纯函数：parentId 结构关系 + 组内相对坐标换算；
 * - Hook：canvas:node-action(layout) 写入组框尺寸与成员坐标的分支与忽略条件。
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachNodesToGroup,
  detachGroupMembers,
  useGroupOperations,
} from "@/features/canvas/hooks/use-group-operations";
import { buildNodeIndex } from "@/features/canvas/shared/group-bounds";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { EventNames, GROUP_NODE_PADDING, NODE_TITLE_HEIGHT, NODE_TYPE } from "@/lib/constants";

// 布局动作会触发落库；单测只关心 store 写入，隔离保存副作用
vi.mock("@/features/canvas/persistence/save-manager", () => ({
  saveManager: { markDirty: vi.fn(), markDirtyImmediate: vi.fn() },
}));

// ── 构造辅助 ──────────────────────────────────────────────

function node(id: string, x: number, y: number, w = 200, h = 120): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x, y },
    style: { width: w, height: h },
    data: { label: id },
  } as unknown as AnyNode;
}

function groupNode(id: string, x: number, y: number, w = 400, h = 300): AnyNode {
  return {
    id,
    type: NODE_TYPE.GROUP,
    position: { x, y },
    style: { width: w, height: h },
    data: { label: id },
  } as unknown as AnyNode;
}

// ── attachNodesToGroup：成员挂入新组 ─────────────────────

describe("attachNodesToGroup", () => {
  it("选中节点写入 parentId，绝对坐标换算为组内相对坐标，成员取消选中", () => {
    const g = groupNode("g1", 160, 110);
    const nodes = [
      node("a", 200, 150),
      node("b", 600, 300),
      node("free", 2000, 2000),
    ];
    const result = attachNodesToGroup(nodes, new Set(["a", "b"]), g, buildNodeIndex(nodes));

    expect(result[0].parentId).toBe("g1");
    expect(result[0].position).toEqual({ x: 200 - 160, y: 150 - 110 });
    expect(result[0].selected).toBe(false);

    expect(result[1].parentId).toBe("g1");
    expect(result[1].position).toEqual({ x: 600 - 160, y: 300 - 110 });

    // 未选中节点不受影响（引用保持）
    expect(result[2]).toBe(nodes[2]);
  });

  it("原为另一组成员的节点重新挂组：绝对坐标按新组原点重算相对位置", () => {
    const oldGroup = groupNode("g0", 100, 100);
    const newGroup = groupNode("g1", 0, 0);
    // 成员 a 原属 g0：position 是 g0 内相对坐标，视觉绝对位置 (150,160)
    const member = { ...node("a", 50, 60), parentId: "g0" } as AnyNode;
    const nodes = [oldGroup, member];

    const result = attachNodesToGroup(nodes, new Set(["a"]), newGroup, buildNodeIndex(nodes));
    expect(result[1].parentId).toBe("g1");
    // 绝对位置 (150,160) → 新组 (0,0) 内相对 (150,160)
    expect(result[1].position).toEqual({ x: 150, y: 160 });
  });
});

// ── detachGroupMembers：成员解出到顶层 ───────────────────

describe("detachGroupMembers", () => {
  it("成员剥离 parentId，绝对坐标 = 组原点 + 相对坐标，保持选中", () => {
    const g = groupNode("g1", 160, 110);
    const memberA = { ...node("a", 40, 40), parentId: "g1", selected: false } as AnyNode;
    const memberB = { ...node("b", 100, 80), parentId: "g1", selected: false } as AnyNode;
    const other = { ...node("c", 0, 0), parentId: "g2" } as AnyNode;
    const nodes = [g, memberA, memberB, other];

    const result = detachGroupMembers(nodes, g);

    expect(result[1].parentId).toBeUndefined();
    expect(result[1].position).toEqual({ x: 160 + 40, y: 110 + 40 });
    expect(result[1].selected).toBe(true);

    expect(result[2].parentId).toBeUndefined();
    expect(result[2].position).toEqual({ x: 160 + 100, y: 110 + 80 });

    // 其他组的成员不受影响（引用保持）
    expect(result[3]).toBe(other);
  });

  it("组节点自身原样保留（成员判定不把组算进去）", () => {
    const g = groupNode("g1", 10, 20);
    const result = detachGroupMembers([g], g);
    expect(result[0]).toBe(g);
  });
});

// ── useGroupOperations：组内布局动作 ─────────────────────

function member(id: string, x: number, y: number, w = 200, h = 120): AnyNode {
  return { ...node(id, x, y, w, h), parentId: "g" } as AnyNode;
}

/** 挂载 hook、派发一次布局动作，返回写入后的 store 快照 */
function runLayout(detail: Record<string, unknown>) {
  const { unmount } = renderHook(() => useGroupOperations());
  act(() => {
    window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail }));
  });
  unmount();
  return useCanvasStore.getState();
}

/** 播种一个初始组框与成员，返回播种结果供断言对照 */
function seedGroup() {
  const group = groupNode("g", 100, 100);
  const members = [member("a", 40, 60), member("b", 400, 60, 200, 300)];
  useCanvasStore.setState({ nodes: [group, ...members], edges: [] });
  return {
    group,
    members,
    size: [Number(group.style?.width), Number(group.style?.height)],
  };
}

describe("useGroupOperations onNodeAction(layout)", () => {
  afterEach(() => {
    cleanup();
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  it("四种模式都写入组框尺寸与成员组内坐标，组节点自身不动", () => {
    for (const mode of ["grid", "horizontal", "vertical", "smart"] as const) {
      const seeded = seedGroup();
      const { nodes } = runLayout({ nodeId: "g", action: "layout", mode });

      const group = nodes.find((n) => n.id === "g")!;
      const width = Number(group.style?.width);
      const height = Number(group.style?.height);
      expect(group.position).toEqual(seeded.group.position);
      // 布局是唯一允许组框收缩的路径：尺寸相对初始组框重算
      expect([width, height]).not.toEqual(seeded.size);

      for (const original of seeded.members) {
        const memberWidth = Number(original.style?.width);
        const memberHeight = Number(original.style?.height);
        const n = nodes.find((candidate) => candidate.id === original.id)!;
        expect(n.parentId).toBe("g");
        expect(n.position.x).toBeGreaterThanOrEqual(GROUP_NODE_PADDING);
        expect(n.position.y).toBeGreaterThanOrEqual(NODE_TITLE_HEIGHT + GROUP_NODE_PADDING);
        expect(n.position.x + memberWidth).toBeLessThanOrEqual(width);
        expect(n.position.y + memberHeight).toBeLessThanOrEqual(height);
      }

      // 布局确实落盘：成员原始组内坐标已被覆盖
      const first = seeded.members[0];
      expect(nodes.find((n) => n.id === first.id)!.position).not.toEqual(first.position);
    }
  });

  it("缺省 mode 等同于宫格", () => {
    seedGroup();
    const implicit = runLayout({ nodeId: "g", action: "layout" });
    seedGroup();
    const grid = runLayout({ nodeId: "g", action: "layout", mode: "grid" });

    expect(implicit.nodes).toEqual(grid.nodes);
  });

  it("非组节点、未知节点与非 layout 动作都被忽略", () => {
    for (const detail of [
      { nodeId: "free", action: "layout", mode: "grid" },
      { nodeId: "ghost", action: "layout", mode: "grid" },
      { nodeId: "g", action: "align" },
    ]) {
      useCanvasStore.setState({
        nodes: [groupNode("g", 0, 0), member("a", 40, 60), node("free", 500, 500)],
        edges: [],
      });
      const before = useCanvasStore.getState().nodes;
      expect(runLayout(detail).nodes).toBe(before);
    }
  });

  it("没有成员的组忽略布局动作", () => {
    useCanvasStore.setState({ nodes: [groupNode("g", 0, 0)], edges: [] });
    const before = useCanvasStore.getState().nodes;

    expect(runLayout({ nodeId: "g", action: "layout", mode: "grid" }).nodes).toBe(before);
  });
});

// ── useGroupOperations：编组创建几何 ─────────────────────

describe("useGroupOperations onGroupNodes", () => {
  afterEach(() => {
    cleanup();
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  /** 挂载 hook、派发一次编组动作，返回写入后的 store 快照 */
  function runGroup() {
    const { unmount } = renderHook(() => useGroupOperations());
    act(() => {
      window.dispatchEvent(new CustomEvent(EventNames.CANVAS_GROUP_NODES));
    });
    unmount();
    return useCanvasStore.getState();
  }

  it("组 body 四边保持 40px：组框向上多扩标题带，成员绝对位置不变", () => {
    useCanvasStore.setState({
      nodes: [
        { ...node("a", 100, 100), selected: true },
        { ...node("b", 400, 300), selected: true },
      ],
      edges: [],
    });

    const { nodes } = runGroup();
    const group = nodes.find((n) => n.type === NODE_TYPE.GROUP)!;
    const memberA = nodes.find((n) => n.id === "a")!;
    const memberB = nodes.find((n) => n.id === "b")!;

    // 成员并集 (100,100)-(600,420)：组节点顶边 = minY - 28 标题带 - 40 body 内边距
    expect(group.position).toEqual({ x: 60, y: 32 });
    expect(Number(group.style?.width)).toBe(580);
    expect(Number(group.style?.height)).toBe(428);

    // 成员绝对位置不变；相对坐标 = 绝对坐标 - 组原点
    expect(memberA.parentId).toBe(group.id);
    expect(memberA.position).toEqual({ x: 40, y: 68 });
    expect(memberB.parentId).toBe(group.id);
    expect(memberB.position).toEqual({ x: 340, y: 268 });

    // body 四边 40px：上/左与右/下分别验证
    expect(memberA.position.x).toBe(GROUP_NODE_PADDING);
    expect(memberA.position.y).toBe(NODE_TITLE_HEIGHT + GROUP_NODE_PADDING);
    expect(
      memberB.position.x + Number(memberB.style?.width) + GROUP_NODE_PADDING,
    ).toBe(Number(group.style?.width));
    expect(
      memberB.position.y + Number(memberB.style?.height) + GROUP_NODE_PADDING,
    ).toBe(Number(group.style?.height));
  });
});
