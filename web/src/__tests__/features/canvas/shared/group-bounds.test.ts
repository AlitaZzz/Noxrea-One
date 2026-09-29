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
  memberRailWidth,
  pruneEmptyGroups,
  refitGroupRects,
  resolveDropGroupId,
} from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, NODE_TYPE, RAIL_WIDTH } from "@/lib/constants";

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

  it("前置契约：空组即删，不再有空组收缩路径（空成员数组为非法输入）", () => {
    // 组必有成员（pruneEmptyGroups 在三处归属减少入口统一删除空组），
    // 此处只验证非法输入下不会产生收缩到最小尺寸的旧行为
    const g = group("g1", 123, 456, 800, 600);
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

describe("pruneEmptyGroups（空组即删）", () => {
  it("删除没有任何成员的组，有成员的组保留", () => {
    const nodes = [
      group("empty", 0, 0, 100, 100),
      node("a", 0, 0, 50, 50, { type: "text-node", data: { groupId: "kept" } }),
      group("kept", 0, 0, 200, 200),
    ];
    const out = pruneEmptyGroups(nodes);
    expect(out.map((n) => n.id)).toEqual(["a", "kept"]);
  });

  it("无空组时返回原数组引用（零拷贝快路径）", () => {
    const nodes = [
      node("a", 0, 0, 50, 50, { type: "text-node", data: { groupId: "g" } }),
      group("g", 0, 0, 100, 100),
    ];
    expect(pruneEmptyGroups(nodes)).toBe(nodes);
  });

  it("没有组的数组返回原引用", () => {
    const nodes = [node("a", 0, 0, 50, 50, { type: "text-node" })];
    expect(pruneEmptyGroups(nodes)).toBe(nodes);
  });

  it("成员归属被剥空即视为空组（removeNodes 先剥离后判空的依据）", () => {
    const nodes = [
      node("a", 0, 0, 50, 50, { type: "text-node", data: { groupId: undefined } }),
      group("g", 0, 0, 100, 100),
    ];
    expect(pruneEmptyGroups(nodes).map((n) => n.id)).toEqual(["a"]);
  });

  it("组节点带的 groupId 不算成员归属（不存在嵌套组，空组全删）", () => {
    const nodes = [
      // nested 是组节点，即便 data.groupId 指向外层也不能免外层于删除；
      // 它自己也没有成员，同样被删
      node("nested", 0, 0, 50, 50, { type: NODE_TYPE.GROUP, data: { groupId: "outer" } }),
      group("outer", 0, 0, 300, 300),
    ];
    const out = pruneEmptyGroups(nodes);
    expect(out).toEqual([]);
  });

  it("多个组只删空的，顺序保持不变", () => {
    const nodes = [
      group("g1", 0, 0, 100, 100),
      node("a", 0, 0, 50, 50, { type: "text-node", data: { groupId: "g2" } }),
      group("g2", 0, 0, 100, 100),
      group("g3", 0, 0, 100, 100),
      node("b", 10, 10, 50, 50, { type: "text-node", data: { groupId: "g1" } }),
    ];
    expect(pruneEmptyGroups(nodes).map((n) => n.id)).toEqual(["g1", "a", "g2", "b"]);
  });
});

describe("memberRailWidth（成员轨道不伸出组边界）", () => {
  // 组 (0,0) 400×300；成员一律 100×50
  const g = group("g", 0, 0, 400, 300);
  const memberAt = (id: string, x: number, gid?: string) =>
    node(id, x, 0, 100, 50, { type: "text-node", data: { groupId: gid ?? "g" } });

  it("无组归属的节点不夹取，返回全宽", () => {
    const nodes = [g, memberAt("free", 100, undefined)];
    // free 的 data.groupId 为 undefined
    expect(memberRailWidth(nodes, "free", "right")).toBe(RAIL_WIDTH);
    expect(memberRailWidth(nodes, "free", "left")).toBe(RAIL_WIDTH);
  });

  it("幽灵 groupId（组已被删）不夹取", () => {
    const nodes = [g, memberAt("orphan", 100, "missing")];
    expect(memberRailWidth(nodes, "orphan", "right")).toBe(RAIL_WIDTH);
  });

  it("贴边成员（净距恰为 GROUP_NODE_PADDING）条带夹到 40", () => {
    // 右缘 360，组右缘 400 → 净距 40
    const nodes = [g, memberAt("flush", 260)];
    expect(memberRailWidth(nodes, "flush", "right")).toBe(GROUP_NODE_PADDING);
    // 左侧净距 260 → 上限夹取
    expect(memberRailWidth(nodes, "flush", "left")).toBe(RAIL_WIDTH);
  });

  it("净距介于 padding 与全宽之间时条带精确到净距；超出全宽夹到上限", () => {
    // 右缘 340 → 净距 60
    expect(memberRailWidth([g, memberAt("mid", 240)], "mid", "right")).toBe(60);
    // 右缘 200 → 净距 200，不夹
    expect(memberRailWidth([g, memberAt("far", 100)], "far", "right")).toBe(RAIL_WIDTH);
  });

  it("组被手动缩小到成员之外（净距 ≤ 0，无外界可守）不夹取", () => {
    // 组右缘 350，成员右缘 360 → 净距 -10
    const shrunk = group("shrunk", 250, 0, 100, 300);
    const nodes = [shrunk, memberAt("out", 260, "shrunk")];
    expect(memberRailWidth(nodes, "out", "right")).toBe(RAIL_WIDTH);
  });

  it("成员不存在（id 幽灵）不夹取", () => {
    expect(memberRailWidth([g], "ghost", "right")).toBe(RAIL_WIDTH);
  });
});

describe("resolveDropGroupId（拖入归属判定：高亮与 drag stop 共用口径）", () => {
  // 组 g (0,0) 400×300，组 h (1000,0) 400×300；成员 100×50
  const g = group("g", 0, 0, 400, 300);
  const h = group("h", 1000, 0, 400, 300);
  const memberAt = (id: string, x: number, y: number, gid?: string) =>
    node(id, x, y, 100, 50, { type: "text-node", data: { groupId: gid } });

  it("中心仍在原组内：归属不变，返回原组 id（不产生新高亮）", () => {
    const m = memberAt("a", 100, 100, "g");
    expect(resolveDropGroupId([g, h, m], m)).toBe("g");
  });

  it("拖出原组到空白：返回 undefined（脱离）", () => {
    const m = memberAt("a", 600, 0, "g");
    expect(resolveDropGroupId([g, h, m], m)).toBeUndefined();
  });

  it("拖入另一组：返回目标组 id（拖入高亮宿主）", () => {
    const m = memberAt("a", 1150, 100, "g");
    expect(resolveDropGroupId([g, h, m], m)).toBe("h");
  });

  it("节点大部分面积在组内但中心在外：不归属（中心点口径）", () => {
    // 中心 x = 350+50 = 400 恰在组右缘（含边界）→ 归属；再外移即脱离
    const onEdge = memberAt("a", 350, 100, undefined);
    expect(resolveDropGroupId([g, onEdge], onEdge)).toBe("g");
    const outside = memberAt("a", 355, 100, undefined);
    expect(resolveDropGroupId([g, outside], outside)).toBeUndefined();
  });

  it("原组已删（幽灵 groupId）：按落点重新判定，不因幽灵 id 兜底", () => {
    const m = memberAt("a", 1150, 100, "ghost");
    expect(resolveDropGroupId([g, h, m], m)).toBe("h");
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
