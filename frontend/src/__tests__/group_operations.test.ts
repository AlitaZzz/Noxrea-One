/**
 * 编组/取消编组坐标计算测试。
 *
 * 测试纯函数层面的 bounding-box 计算、子节点坐标变换，
 * 不涉及 store 操作或事件绑定。
 */

import { describe, it, expect } from "vitest";
import { GROUP_NODE_PADDING } from "@/lib/constants";
import type { AnyNode } from "@/lib/types";

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

// ── 纯函数：将子节点坐标转为父节点相对坐标 ──────────────────────

function toParentRelative(
  nodes: AnyNode[],
  selectedIds: Set<string>,
  groupX: number,
  groupY: number,
  groupId: string,
): AnyNode[] {
  return nodes.map((n) => {
    if (selectedIds.has(n.id)) {
      return {
        ...n,
        parentId: groupId,
        position: {
          x: n.position.x - groupX,
          y: n.position.y - groupY,
        },
        extent: "parent" as const,
        selected: false,
      };
    }
    return n;
  });
}

// ── 纯函数：将子节点坐标恢复为绝对坐标 ──────────────────────────

function toAbsolutePosition(
  nodes: AnyNode[],
  groupId: string,
  groupX: number,
  groupY: number,
): AnyNode[] {
  return nodes.map((n) => {
    if (n.parentId === groupId) {
      return {
        ...n,
        parentId: undefined,
        extent: undefined,
        position: {
          x: n.position.x + groupX,
          y: n.position.y + groupY,
        },
      };
    }
    return n;
  });
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

describe("toParentRelative", () => {
  it("子节点坐标转为相对于 group 的偏移", () => {
    const nodes = [
      { id: "a", position: { x: 200, y: 150 }, style: { width: 100, height: 80 } },
      { id: "b", position: { x: 350, y: 200 }, style: { width: 120, height: 60 } },
    ] as AnyNode[];
    const groupX = 160, groupY = 110;
    const result = toParentRelative(nodes, new Set(["a", "b"]), groupX, groupY, "group1");

    expect(result[0].parentId).toBe("group1");
    expect(result[0].position).toEqual({ x: 40, y: 40 });  // 200-160, 150-110
    expect(result[0].extent).toBe("parent");
    expect(result[0].selected).toBe(false);

    expect(result[1].parentId).toBe("group1");
    expect(result[1].position).toEqual({ x: 190, y: 90 });  // 350-160, 200-110
  });

  it("未选中的节点不受影响", () => {
    const nodes = [
      { id: "a", position: { x: 100, y: 100 } },
      { id: "b", position: { x: 300, y: 100 } },
    ] as AnyNode[];
    const result = toParentRelative(nodes, new Set(["a"]), 80, 80, "g1");
    expect(result[0].parentId).toBe("g1");
    expect(result[1].parentId).toBeUndefined();
    expect(result[1].position).toEqual({ x: 300, y: 100 });
  });
});

describe("toAbsolutePosition", () => {
  it("恢复子节点到原始绝对坐标", () => {
    const nodes = [
      {
        id: "a", parentId: "g1",
        position: { x: 40, y: 40 },
        extent: "parent" as const,
      },
      { id: "b", parentId: undefined, position: { x: 500, y: 200 } },
    ] as AnyNode[];
    const result = toAbsolutePosition(nodes, "g1", 160, 110);

    expect(result[0].parentId).toBeUndefined();
    expect(result[0].extent).toBeUndefined();
    expect(result[0].position).toEqual({ x: 200, y: 150 });  // 40+160, 40+110
    // 非子节点不受影响
    expect(result[1].parentId).toBeUndefined();
    expect(result[1].position).toEqual({ x: 500, y: 200 });
  });

  it("多个 group 各自恢复子节点", () => {
    const nodes = [
      { id: "a", parentId: "g1", position: { x: 10, y: 20 } },
      { id: "b", parentId: "g2", position: { x: 30, y: 40 } },
    ] as AnyNode[];
    const r1 = toAbsolutePosition(nodes, "g1", 100, 200);
    expect(r1[0].position).toEqual({ x: 110, y: 220 });
    expect(r1[1].position).toEqual({ x: 30, y: 40 });  // g2's child not affected

    const r2 = toAbsolutePosition(nodes, "g2", 300, 400);
    expect(r2[0].position).toEqual({ x: 10, y: 20 });  // g1's child not affected
    expect(r2[1].position).toEqual({ x: 330, y: 440 });
  });
});
