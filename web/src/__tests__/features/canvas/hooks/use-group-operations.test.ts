/**
 * 编组/取消编组坐标计算测试。
 *
 * 测试纯函数层面的 bounding-box 计算、子节点坐标变换，
 * 不涉及 store 操作或事件绑定。
 */

import { describe, expect,it } from "vitest";

import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING } from "@/lib/constants";

// ── 纯函数：计算选中节点的 bounding box ──────────────────────────

interface BoundingBox {
  minX: number; minY: number; maxX: number; maxY: number;
}

function computeBoundingBox(nodes: AnyNode[]): BoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = Number(n.style?.width) || 200;
    const h = Number(n.style?.height) || 120;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return { minX, minY, maxX, maxY };
}

function computeGroupBox(nodes: AnyNode[]): { x: number; y: number; w: number; h: number } {
  const { minX, minY, maxX, maxY } = computeBoundingBox(nodes);
  return {
    x: minX - GROUP_NODE_PADDING,
    y: minY - GROUP_NODE_PADDING,
    w: maxX - minX + GROUP_NODE_PADDING * 2,
    h: maxY - minY + GROUP_NODE_PADDING * 2,
  };
}

// ── 纯函数：为子节点打上 groupId 逻辑归属（坐标保持绝对不变） ──

function assignGroup(
  nodes: AnyNode[],
  selectedIds: Set<string>,
  groupId: string,
): AnyNode[] {
  return nodes.map((n) => {
    if (selectedIds.has(n.id)) {
      return {
        ...n,
        data: { ...n.data, groupId },
        selected: false,
      };
    }
    return n;
  }) as AnyNode[];
}

// ── 纯函数：清除子节点的 groupId 归属（坐标保持绝对不变） ────────

function clearGroup(nodes: AnyNode[], groupId: string): AnyNode[] {
  return nodes.map((n) => {
    if ((n.data as { groupId?: string })?.groupId === groupId) {
      const { groupId: _omit, ...rest } = n.data as Record<string, unknown> & {
        groupId?: string;
      };
      return { ...n, data: rest };
    }
    return n;
  }) as AnyNode[];
}

// ── 测试 ─────────────────────────────────────────────────────────

describe("computeBoundingBox", () => {
  it("两个节点并排", () => {
    const nodes = [
      { id: "a", position: { x: 100, y: 200 }, style: { width: 300, height: 200 } },
      { id: "b", position: { x: 500, y: 200 }, style: { width: 400, height: 150 } },
    ] as AnyNode[];
    const box = computeBoundingBox(nodes);
    expect(box.minX).toBe(100);
    expect(box.minY).toBe(200);
    expect(box.maxX).toBe(900);  // max(100+300=400, 500+400=900)
    expect(box.maxY).toBe(400);  // max(200+200=400, 200+150=350)
  });

  it("节点错位排列", () => {
    const nodes = [
      { id: "a", position: { x: 0, y: 0 }, style: { width: 100, height: 100 } },
      { id: "b", position: { x: 50, y: 80 }, style: { width: 200, height: 60 } },
    ] as AnyNode[];
    const box = computeBoundingBox(nodes);
    expect(box.minX).toBe(0);
    expect(box.minY).toBe(0);
    expect(box.maxX).toBe(250);  // 50 + 200
    expect(box.maxY).toBe(140);  // 80 + 60
  });

  it("单个节点", () => {
    const nodes = [
      { id: "a", position: { x: 400, y: 300 }, style: { width: 200, height: 100 } },
    ] as AnyNode[];
    const box = computeBoundingBox(nodes);
    expect(box.minX).toBe(400);
    expect(box.minY).toBe(300);
    expect(box.maxX).toBe(600);
    expect(box.maxY).toBe(400);
  });

  it("节点无 style 时使用默认值 200x120", () => {
    const nodes = [
      { id: "a", position: { x: 10, y: 20 } },
    ] as AnyNode[];
    const box = computeBoundingBox(nodes);
    expect(box.maxX).toBe(210);  // 10 + 200
    expect(box.maxY).toBe(140);  // 20 + 120
  });
});

describe("computeGroupBox", () => {
  it("bounding box 加上 GROUP_NODE_PADDING(40)", () => {
    const nodes = [
      { id: "a", position: { x: 200, y: 150 }, style: { width: 300, height: 200 } },
      { id: "b", position: { x: 600, y: 300 }, style: { width: 200, height: 100 } },
    ] as AnyNode[];
    const g = computeGroupBox(nodes);
    expect(g.x).toBe(160);    // 200 - 40
    expect(g.y).toBe(110);    // 150 - 40
    expect(g.w).toBe(680);    // (800 - 200) + 80
    expect(g.h).toBe(330);    // (400 - 150) + 80
  });
});

describe("assignGroup", () => {
  it("为子节点打上 groupId，坐标保持绝对不变", () => {
    const nodes = [
      { id: "a", position: { x: 200, y: 150 }, style: { width: 100, height: 80 } },
      { id: "b", position: { x: 350, y: 200 }, style: { width: 120, height: 60 } },
    ] as AnyNode[];
    const result = assignGroup(nodes, new Set(["a", "b"]), "group1");

    expect((result[0].data as { groupId?: string }).groupId).toBe("group1");
    expect(result[0].position).toEqual({ x: 200, y: 150 });  // 坐标不变
    expect(result[0].selected).toBe(false);

    expect((result[1].data as { groupId?: string }).groupId).toBe("group1");
    expect(result[1].position).toEqual({ x: 350, y: 200 });
  });

  it("未选中的节点不受影响", () => {
    const nodes = [
      { id: "a", position: { x: 100, y: 100 }, data: {} },
      { id: "b", position: { x: 300, y: 100 }, data: {} },
    ] as AnyNode[];
    const result = assignGroup(nodes, new Set(["a"]), "g1");
    expect((result[0].data as { groupId?: string }).groupId).toBe("g1");
    expect((result[1].data as { groupId?: string }).groupId).toBeUndefined();
    expect(result[1].position).toEqual({ x: 300, y: 100 });
  });
});

describe("clearGroup", () => {
  it("清除子节点的 groupId，坐标保持绝对不变", () => {
    const nodes = [
      { id: "a", position: { x: 200, y: 150 }, data: { groupId: "g1" } },
      { id: "b", position: { x: 500, y: 200 }, data: {} },
    ] as AnyNode[];
    const result = clearGroup(nodes, "g1");

    expect((result[0].data as { groupId?: string }).groupId).toBeUndefined();
    expect(result[0].position).toEqual({ x: 200, y: 150 });  // 坐标不变
    // 非子节点不受影响
    expect((result[1].data as { groupId?: string }).groupId).toBeUndefined();
    expect(result[1].position).toEqual({ x: 500, y: 200 });
  });

  it("多个 group 各自清除成员", () => {
    const nodes = [
      { id: "a", position: { x: 10, y: 20 }, data: { groupId: "g1" } },
      { id: "b", position: { x: 30, y: 40 }, data: { groupId: "g2" } },
    ] as AnyNode[];
    const r1 = clearGroup(nodes, "g1");
    expect((r1[0].data as { groupId?: string }).groupId).toBeUndefined();
    expect((r1[1].data as { groupId?: string }).groupId).toBe("g2");  // g2 不受影响

    const r2 = clearGroup(nodes, "g2");
    expect((r2[0].data as { groupId?: string }).groupId).toBe("g1");  // g1 不受影响
    expect((r2[1].data as { groupId?: string }).groupId).toBeUndefined();
  });
});
