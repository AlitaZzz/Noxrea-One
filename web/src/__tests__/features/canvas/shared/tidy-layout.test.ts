/**
 * 画布整理布局测试。
 *
 * 覆盖：规模边界、网格模式读序排布与锚点保持、分组整体平移、
 * 分层模式的上游在左与链路不折行、成环与孤立节点兜底、
 * 超宽节点不重叠、网格吸附。
 */

import type { Edge } from "@xyflow/react";
import { describe, expect,it } from "vitest";

import { computeTidyLayout } from "@/features/canvas/shared/tidy-layout";
import type { AnyNode } from "@/features/canvas/types";
import { LAYOUT_GAP, NODE_TYPE } from "@/lib/constants";

// ── 构造辅助 ──────────────────────────────────────────────

function node(
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 120,
  groupId?: string,
): AnyNode {
  return {
    id,
    type: NODE_TYPE.IMAGE,
    position: { x, y },
    style: { width, height },
    data: groupId ? { label: id, groupId } : { label: id },
  } as unknown as AnyNode;
}

function groupNode(id: string, x: number, y: number, width = 400, height = 300): AnyNode {
  return {
    id,
    type: NODE_TYPE.GROUP,
    position: { x, y },
    style: { width, height },
    data: { label: id },
  } as unknown as AnyNode;
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

/** 任意两节点是否互不重叠（边接触不算重叠） */
function findOverlap(nodes: AnyNode[]): [string, string] | null {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const aw = Number(a.style?.width) || 200;
      const ah = Number(a.style?.height) || 120;
      const bw = Number(b.style?.width) || 200;
      const bh = Number(b.style?.height) || 120;
      const overlapX =
        a.position.x < b.position.x + bw && b.position.x < a.position.x + aw;
      const overlapY =
        a.position.y < b.position.y + bh && b.position.y < a.position.y + ah;
      if (overlapX && overlapY) return [a.id, b.id];
    }
  }
  return null;
}

/** 把整理结果应用到节点副本上 */
function apply(
  nodes: AnyNode[],
  positions: Map<string, { x: number; y: number }>,
): AnyNode[] {
  return nodes.map((n) => {
    const p = positions.get(n.id);
    return p ? ({ ...n, position: p } as AnyNode) : n;
  });
}

/** 取整理后的坐标 */
function posOf(nodes: AnyNode[], positions: Map<string, { x: number; y: number }>) {
  const placed = apply(nodes, positions);
  return (id: string) => placed.find((n) => n.id === id)!.position;
}

// ── 规模边界 ──────────────────────────────────────────────

describe("computeTidyLayout 规模边界", () => {
  it("空画布不产生任何移动", () => {
    const r = computeTidyLayout([], []);
    expect(r.positions.size).toBe(0);
    expect(r.movedCount).toBe(0);
  });

  it("单个节点不产生任何移动", () => {
    const r = computeTidyLayout([node("a", 10, 20)], []);
    expect(r.movedCount).toBe(0);
  });

  it("只有一组（组 + 成员）时视为单个块，不产生移动", () => {
    const r = computeTidyLayout(
      [groupNode("g", 0, 0), node("m1", 40, 60, 100, 80, "g")],
      [],
    );
    expect(r.movedCount).toBe(0);
  });
});

// ── 网格模式 ──────────────────────────────────────────────

describe("computeTidyLayout 网格模式", () => {
  it("按读序分行排列，行内净间距恒为 LAYOUT_GAP", () => {
    // 四个节点纵向错开，读序应为 b -> a -> c -> d
    const nodes = [
      node("a", 500, 300),
      node("b", 100, 50),
      node("c", 900, 700),
      node("d", 200, 800),
    ];
    const r = computeTidyLayout(nodes, [], { mode: "grid", maxRowWidth: 10_000 });
    const pos = posOf(nodes, r.positions);

    // 2 列（ceil(sqrt(4))），第一行 b、a，第二行 c、d
    expect(pos("b").y).toBe(pos("a").y);
    expect(pos("c").y).toBe(pos("d").y);
    expect(pos("a").x - (pos("b").x + 200)).toBe(LAYOUT_GAP);
    expect(pos("c").y - (pos("b").y + 120)).toBe(LAYOUT_GAP);
  });

  it("结果左上角对齐原内容包围盒，内容不会飞走", () => {
    const nodes = [node("a", 500, 300), node("b", 100, 50), node("c", 900, 700)];
    const r = computeTidyLayout(nodes, [], { mode: "grid" });
    const placed = apply(nodes, r.positions);

    expect(Math.min(...placed.map((n) => n.position.x))).toBe(100);
    expect(Math.min(...placed.map((n) => n.position.y))).toBe(50);
  });

  it("整理后任意两节点不重叠", () => {
    const nodes = [
      node("a", 0, 0, 300, 200),
      node("b", 120, 90, 150, 400),
      node("c", 700, 30, 500, 120),
      node("d", 60, 600, 220, 180),
    ];
    const r = computeTidyLayout(nodes, [], { mode: "grid", maxRowWidth: 1200 });
    expect(findOverlap(apply(nodes, r.positions))).toBeNull();
  });

  it("已经整齐的布局不会产生多余移动", () => {
    const nodes = [node("a", 0, 0), node("b", 200 + LAYOUT_GAP, 0)];
    const r = computeTidyLayout(nodes, [], { mode: "grid", maxRowWidth: 10_000 });
    expect(r.movedCount).toBe(0);
  });
});

// ── 分组整体平移 ──────────────────────────────────────────

describe("computeTidyLayout 分组", () => {
  it("组成员随组块整体平移，相对偏移保持不变", () => {
    const nodes = [
      groupNode("g", 0, 0, 400, 300),
      node("m1", 40, 60, 100, 80, "g"),
      node("m2", 200, 160, 120, 90, "g"),
      node("o", 1000, 1000),
    ];
    const r = computeTidyLayout(nodes, [], { mode: "grid" });
    const g = r.positions.get("g")!;
    const m1 = r.positions.get("m1")!;
    const m2 = r.positions.get("m2")!;

    expect(m1.x - g.x).toBe(40);
    expect(m1.y - g.y).toBe(60);
    expect(m2.x - g.x).toBe(200);
    expect(m2.y - g.y).toBe(160);
  });

  it("组成员不参与顶层排序（不会被单独插到组外）", () => {
    const nodes = [
      groupNode("g", 0, 0, 400, 300),
      node("m1", 40, 60, 100, 80, "g"),
      node("a", 2000, 2000),
    ];
    const r = computeTidyLayout(nodes, [], { mode: "grid", maxRowWidth: 10_000 });
    // 只有 2 个顶层块：组 与 a
    expect(r.positions.size).toBe(3);
    const pos = posOf(nodes, r.positions);
    expect(pos("g").y).toBe(pos("a").y);
    expect(pos("a").x).toBeGreaterThan(pos("g").x);
  });

  it("groupId 指向不存在的组时按未分组处理", () => {
    const nodes = [node("a", 0, 0), node("b", 500, 400, 200, 120, "ghost")];
    const r = computeTidyLayout(nodes, [], { mode: "grid" });
    expect(r.positions.has("b")).toBe(true);
    expect(r.movedCount).toBeGreaterThan(0);
  });
});

// ── 分层模式（有连线画布的核心语义） ──────────────────────

describe("computeTidyLayout 分层模式", () => {
  it("上游排在最左，链路沿水平方向推进且不被折行", () => {
    // 5 节点长链：网格模式会把第 5 个折到第二行，分层模式不会
    const nodes = ["a", "b", "c", "d", "e"].map((id, i) => node(id, i * 10, i * 10));
    const edges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
    ];
    const r = computeTidyLayout(nodes, edges, { mode: "auto" });
    const pos = posOf(nodes, r.positions);

    expect(pos("a").x).toBeLessThan(pos("b").x);
    expect(pos("b").x).toBeLessThan(pos("c").x);
    expect(pos("c").x).toBeLessThan(pos("d").x);
    expect(pos("d").x).toBeLessThan(pos("e").x);
    // 关键：整条链路在同一水平线上，没有节点被甩到下一行
    const ys = ["a", "b", "c", "d", "e"].map((id) => pos(id).y);
    expect(new Set(ys).size).toBe(1);
    expect(findOverlap(apply(nodes, r.positions))).toBeNull();
  });

  it("即便原始坐标完全倒序，上游仍排在最左", () => {
    const nodes = [node("c", 0, 0), node("b", 600, 0), node("a", 1200, 0)];
    const edges = [edge("a", "b"), edge("b", "c")];
    const r = computeTidyLayout(nodes, edges, { mode: "layer" });
    const pos = posOf(nodes, r.positions);

    expect(pos("a").x).toBeLessThan(pos("b").x);
    expect(pos("b").x).toBeLessThan(pos("c").x);
    expect(pos("a").y).toBe(pos("b").y);
    expect(pos("b").y).toBe(pos("c").y);
  });

  it("同层（同一拓扑层）的多个节点垂直排成一列", () => {
    // a -> b、a -> c，b 与 c 同层
    const nodes = [node("a", 0, 0), node("b", 500, 500), node("c", 900, 900)];
    const edges = [edge("a", "b"), edge("a", "c")];
    const r = computeTidyLayout(nodes, edges, { mode: "layer" });
    const pos = posOf(nodes, r.positions);

    expect(pos("a").x).toBeLessThan(pos("b").x);
    expect(pos("b").x).toBe(pos("c").x);
    // b、c 同层垂直排列，间距 = 节点高 + 净间距；上下顺序由交叉最小化决定，不做强约束
    expect(Math.abs(pos("c").y - pos("b").y)).toBe(120 + LAYOUT_GAP);
  });

  it("组内连线在块级别生效（成员边映射为所在组的边）", () => {
    const nodes = [
      groupNode("g", 0, 0, 400, 300),
      node("m1", 40, 60, 100, 80, "g"),
      node("a", 3000, 3000),
    ];
    // a -> m1 等价于 a -> 组 g，因此 a 应排在组左侧
    const edges = [edge("a", "m1")];
    const r = computeTidyLayout(nodes, edges, { mode: "layer" });
    expect(r.positions.get("a")!.x).toBeLessThan(r.positions.get("g")!.x);
  });

  it("分叉与汇聚的多层结构不重叠", () => {
    // a -> b, a -> c, b -> d, c -> d
    const nodes = [
      node("a", 0, 0),
      node("b", 400, 200),
      node("c", 400, 600),
      node("d", 900, 400),
    ];
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    const r = computeTidyLayout(nodes, edges, { mode: "layer" });
    const pos = posOf(nodes, r.positions);

    expect(pos("a").x).toBeLessThan(pos("b").x);
    expect(pos("b").x).toBe(pos("c").x);
    expect(pos("d").x).toBeGreaterThan(pos("b").x);
    expect(findOverlap(apply(nodes, r.positions))).toBeNull();
  });

  it("成环时不丢节点", () => {
    const nodes = [node("a", 0, 0), node("b", 500, 0)];
    const edges = [edge("a", "b"), edge("b", "a")];
    const r = computeTidyLayout(nodes, edges, { mode: "layer" });
    expect(r.positions.size).toBe(2);
    expect(findOverlap(apply(nodes, r.positions))).toBeNull();
  });

  it("孤立节点排到最右侧一列，不打断主链路", () => {
    const nodes = [
      node("solo", 0, 0),
      node("up", 800, 800),
      node("down", 1200, 1200),
    ];
    const edges = [edge("up", "down")];
    const r = computeTidyLayout(nodes, edges, { mode: "layer" });
    const pos = posOf(nodes, r.positions);

    expect(pos("up").x).toBeLessThan(pos("down").x);
    expect(pos("solo").x).toBeGreaterThan(pos("down").x);
  });
});

// ── 模式自动选择与边界 ────────────────────────────────────

describe("computeTidyLayout 模式选择与边界", () => {
  it("auto 且无连线时走网格", () => {
    const nodes = [node("a", 0, 0), node("b", 500, 0)];
    const auto = computeTidyLayout(nodes, [], { mode: "auto" });
    const grid = computeTidyLayout(nodes, [], { mode: "grid" });
    expect(auto.positions.get("a")).toEqual(grid.positions.get("a"));
    expect(auto.positions.get("b")).toEqual(grid.positions.get("b"));
  });

  it("auto 且有连线时走分层（而非网格折行）", () => {
    const nodes = [node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)];
    const edges = [edge("a", "b"), edge("b", "c")];
    const auto = computeTidyLayout(nodes, edges, { mode: "auto" });
    const layer = computeTidyLayout(nodes, edges, { mode: "layer" });
    expect(auto.positions.get("a")).toEqual(layer.positions.get("a"));
    expect(auto.positions.get("c")).toEqual(layer.positions.get("c"));
  });

  it("超宽节点独占一列，不与后续节点重叠", () => {
    const nodes = [
      node("wide", 0, 0, 3000, 200),
      node("a", 100, 500),
      node("b", 400, 900),
    ];
    const r = computeTidyLayout(nodes, [], { mode: "grid", maxRowWidth: 1600 });
    const pos = posOf(nodes, r.positions);
    expect(findOverlap(apply(nodes, r.positions))).toBeNull();
    expect(pos("wide").y).toBeLessThan(pos("a").y);
  });

  it("开启吸附时坐标落在网格步长上", () => {
    const nodes = [node("a", 103, 57), node("b", 500, 400)];
    const r = computeTidyLayout(nodes, [], { mode: "grid", snapSize: 20 });
    for (const p of r.positions.values()) {
      expect(p.x % 20).toBe(0);
      expect(p.y % 20).toBe(0);
    }
  });
});
