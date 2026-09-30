/**
 * 编组/取消编组归属变换测试（attachNodesToGroup / detachGroupMembers）。
 * 直接测试 hooks 模块导出的纯函数：parentId 结构关系 + 组内相对坐标换算。
 */

import { describe, expect, it } from "vitest";

import { attachNodesToGroup, detachGroupMembers } from "@/features/canvas/hooks/use-group-operations";
import { buildNodeIndex } from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

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
