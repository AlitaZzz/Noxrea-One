/**
 * computeFittedGroupRect 测试：组框随成员变化的自适应几何。
 */

import { describe, expect, it } from "vitest";

import {
  computeFittedGroupRect,
  findGroupAtPoint,
  groupContainsPoint,
  groupMembers,
  isGroupMember,
  refitGroupRects,
} from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_MIN_HEIGHT, GROUP_NODE_MIN_WIDTH, GROUP_NODE_PADDING, NODE_TYPE } from "@/lib/constants";

function node(id: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): AnyNode {
  return {
    id,
    position: { x, y },
    style: { width: w, height: h },
    ...extra,
  } as unknown as AnyNode;
}

function group(id: string, x: number, y: number, w: number, h: number): AnyNode {
  return node(id, x, y, w, h, { type: NODE_TYPE.GROUP });
}

describe("computeFittedGroupRect", () => {
  it("成员都在组框内时返回 null（无需变化）", () => {
    // 组框 = 成员 bbox(100,100 ~ 400,300) 外扩 padding 40
    const g = group("g1", 100 - GROUP_NODE_PADDING, 100 - GROUP_NODE_PADDING, 300 + GROUP_NODE_PADDING * 2, 200 + GROUP_NODE_PADDING * 2);
    const members = [node("a", 100, 100, 300, 200)];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("成员探出右边时组框扩张，位置不动", () => {
    const g = group("g1", 60, 60, 400, 400);
    const members = [node("a", 100, 100, 500, 100)];
    const rect = computeFittedGroupRect(g, members)!;
    expect(rect.x).toBe(60);
    expect(rect.y).toBe(60);
    // 右边界 = 成员右缘(600) + padding(40) = 640 → 宽 580
    expect(rect.width).toBe(500 + GROUP_NODE_PADDING * 2);
  });

  it("成员探出左上时组框原点随之移动", () => {
    const g = group("g1", 100, 100, 400, 400);
    const members = [node("a", 0, 0, 200, 200)];
    const rect = computeFittedGroupRect(g, members)!;
    expect(rect.x).toBe(-GROUP_NODE_PADDING);
    expect(rect.y).toBe(-GROUP_NODE_PADDING);
    // 右边界 = max(500, 200 + 40) = 500 → 宽 540
    expect(rect.width).toBe(500 + GROUP_NODE_PADDING);
  });

  it("手动放大的组框不因成员变小而收缩（只扩不缩）", () => {
    const g = group("g1", 0, 0, 2000, 2000);
    const members = [node("a", 100, 100, 100, 100)];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("无成员时收缩到最小尺寸（保持左上角）", () => {
    const g = group("g1", 123, 456, 800, 600);
    const rect = computeFittedGroupRect(g, [])!;
    expect(rect.x).toBe(123);
    expect(rect.y).toBe(456);
    expect(rect.width).toBe(GROUP_NODE_MIN_WIDTH);
    expect(rect.height).toBe(GROUP_NODE_MIN_HEIGHT);
  });

  it("无成员且已是最小尺寸时返回 null", () => {
    const g = group("g1", 123, 456, GROUP_NODE_MIN_WIDTH, GROUP_NODE_MIN_HEIGHT);
    expect(computeFittedGroupRect(g, [])).toBeNull();
  });
});

describe("groupContainsPoint", () => {
  it("组框内含边界命中，框外不命中", () => {
    const g = group("g", 0, 0, 100, 50);
    expect(groupContainsPoint(g, { x: 50, y: 25 })).toBe(true);
    expect(groupContainsPoint(g, { x: 100, y: 50 })).toBe(true);
    expect(groupContainsPoint(g, { x: 101, y: 25 })).toBe(false);
    expect(groupContainsPoint(g, { x: 50, y: -1 })).toBe(false);
  });
});

describe("findGroupAtPoint", () => {
  it("返回包含点的组 id，非组节点不参与", () => {
    const nodes = [
      group("g", 0, 0, 100, 100),
      node("a", 0, 0, 50, 50, { type: "text-node" }),
    ];
    expect(findGroupAtPoint(nodes, { x: 50, y: 50 })).toBe("g");
    expect(findGroupAtPoint(nodes, { x: 200, y: 200 })).toBeUndefined();
  });

  it("重叠时数组靠后的组绘制在上层、优先归属", () => {
    const nodes = [group("bottom", 0, 0, 200, 200), group("top", 50, 50, 200, 200)];
    expect(findGroupAtPoint(nodes, { x: 100, y: 100 })).toBe("top");
    expect(findGroupAtPoint(nodes, { x: 10, y: 10 })).toBe("bottom");
  });
});

describe("isGroupMember / groupMembers", () => {
  it("按 data.groupId 显式归属取成员，组节点与无关节点不参与", () => {
    const nodes = [
      node("a", 0, 0, 50, 50, { type: "text-node", data: { groupId: "g" } }),
      node("b", 100, 0, 50, 50, { type: "image-node", data: { groupId: "g" } }),
      node("x", 200, 0, 50, 50, { type: "text-node", data: { groupId: "other" } }),
      node("y", 300, 0, 50, 50, { type: "text-node" }),
      group("g", 0, 0, 100, 100),
      // 带了 groupId 的组节点：组不可能是成员（不存在嵌套组）
      node("nested", 0, 0, 50, 50, { type: NODE_TYPE.GROUP, data: { groupId: "g" } }),
    ];
    expect(groupMembers(nodes, "g").map((n) => n.id)).toEqual(["a", "b"]);
    expect(groupMembers(nodes, "missing")).toEqual([]);
    expect(isGroupMember(nodes[0], "g")).toBe(true);
    expect(isGroupMember(nodes[5], "g")).toBe(false);
  });
});

describe("refitGroupRects", () => {
  it("成员归属变化后重算指定组框，未列出的组与非组节点原样保留", () => {
    // 成员(0,0,200×50) 探出组框(0,0,100×100)左上与右侧：原点随移 -padding、
    // 宽度扩到 成员右缘 + padding（超出 GROUP_NODE_MIN_WIDTH，不被最小尺寸钳住）
    const member = node("a", 0, 0, 200, 50, { type: "text-node", data: { groupId: "g1" } });
    const g1 = group("g1", 0, 0, 100, 100);
    const g2 = group("g2", 1000, 1000, 100, 100);
    const out = refitGroupRects([g1, g2, member], ["g1"]);
    const g1Out = out.find((n) => n.id === "g1")!;
    expect(g1Out.position.x).toBe(-GROUP_NODE_PADDING);
    expect(g1Out.position.y).toBe(-GROUP_NODE_PADDING);
    expect((g1Out.style as { width: number }).width).toBe(200 + GROUP_NODE_PADDING * 2);
    // 未列出的组不动，非组节点原样
    expect(out.find((n) => n.id === "g2")).toBe(g2);
    expect(out.find((n) => n.id === "a")).toBe(member);
  });

  it("成员已在组框内时该组保持原对象（无需变化）", () => {
    const member = node("a", 100, 100, 50, 50, { type: "text-node", data: { groupId: "g1" } });
    const g1 = group("g1", 50, 50, 200, 200);
    const out = refitGroupRects([g1, member], ["g1"]);
    expect(out.find((n) => n.id === "g1")).toBe(g1);
  });
});
