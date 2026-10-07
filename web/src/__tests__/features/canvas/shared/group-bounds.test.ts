/**
 * group-bounds 测试：Sub Flow 模型（parentId + 相对坐标）下的组框自适应几何、
 * 成员判定、拖入归属判定与轨道钳制。
 */

import { describe, expect, it } from "vitest";

import {
  buildGroupHitIndex,
  buildNodeIndex,
  computeFittedGroupRect,
  findGroupAtPoint,
  groupContainsPoint,
  groupMembers,
  isGroupMember,
  nodeAbsolutePosition,
  pruneEmptyGroups,
  refitGroupRects,
  resolveDropGroupId,
  toAbsoluteNodes,
} from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, NODE_TYPE } from "@/lib/constants";

function node(id: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): AnyNode {
  return {
    id,
    position: { x, y },
    style: { width: w, height: h },
    data: {},
    ...extra,
  } as unknown as AnyNode;
}

function group(id: string, x: number, y: number, w: number, h: number): AnyNode {
  return node(id, x, y, w, h, { type: NODE_TYPE.GROUP });
}

/** 组成员：position 为组内相对坐标，parentId 指向组 */
function member(id: string, x: number, y: number, w: number, h: number, gid: string): AnyNode {
  return node(id, x, y, w, h, { type: "text-node", parentId: gid });
}

describe("坐标换算（nodeAbsolutePosition / toAbsoluteNodes）", () => {
  it("成员绝对位置 = 组原点 + 相对位置；顶层节点原样", () => {
    const g = group("g", 100, 200, 500, 400);
    const m = member("m", 10, 20, 100, 50, "g");
    const top = node("t", 5, 6, 30, 30, { type: "text-node" });
    const nodes = [g, m, top];
    const index = buildNodeIndex(nodes);
    expect(nodeAbsolutePosition(m, index)).toEqual({ x: 110, y: 220 });
    expect(nodeAbsolutePosition(top, index)).toEqual({ x: 5, y: 6 });
    expect(nodeAbsolutePosition(g, index)).toEqual({ x: 100, y: 200 });
  });

  it("toAbsoluteNodes：成员换算为绝对视图，顶层节点保持原引用", () => {
    const g = group("g", 100, 100, 500, 400);
    const m = member("m", 10, 20, 100, 50, "g");
    const top = node("t", 0, 0, 30, 30, { type: "text-node" });
    const out = toAbsoluteNodes([g, m, top]);
    expect(out[0]).toBe(g);
    expect(out[1].position).toEqual({ x: 110, y: 120 });
    expect(out[2]).toBe(top);
  });

  it("幽灵 parentId 按顶层处理（尽力而为）", () => {
    const orphan = member("m", 10, 20, 100, 50, "missing");
    expect(nodeAbsolutePosition(orphan, buildNodeIndex([orphan]))).toEqual({ x: 10, y: 20 });
  });
});

describe("computeFittedGroupRect（相对空间 refit）", () => {
  it("成员都在组框内时返回 null（无需变化）", () => {
    // 组原点 (60,60)；成员相对位置 (40,40)，组框 380×280 = 成员 bbox 外扩 padding
    const g = group("g1", 60, 60, 300 + GROUP_NODE_PADDING * 2, 200 + GROUP_NODE_PADDING * 2);
    const members = [member("a", GROUP_NODE_PADDING, GROUP_NODE_PADDING, 300, 200, "g1")];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("成员探出右边时组框扩张，位置不动", () => {
    const g = group("g1", 60, 60, 400, 400);
    // 成员相对位置 (40,40)，宽 500 → 右缘相对 540 + padding 40 = 580
    const members = [member("a", 40, 40, 500, 100, "g1")];
    const rect = computeFittedGroupRect(g, members)!;
    expect(rect.x).toBe(60);
    expect(rect.y).toBe(60);
    expect(rect.width).toBe(500 + GROUP_NODE_PADDING * 2);
  });

  it("成员探出左上时组框原点随之移动", () => {
    const g = group("g1", 100, 100, 400, 400);
    // 相对位置 (-100,-100) → 原点相对 -100-padding
    const members = [member("a", -100, -100, 200, 200, "g1")];
    const rect = computeFittedGroupRect(g, members)!;
    expect(rect.x).toBe(100 - 100 - GROUP_NODE_PADDING);
    expect(rect.y).toBe(100 - 100 - GROUP_NODE_PADDING);
  });

  it("手动放大的组框不因成员变小而收缩（只扩不缩）", () => {
    const g = group("g1", 0, 0, 2000, 2000);
    const members = [member("a", 100, 100, 100, 100, "g1")];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("组内贴边成员（未探出）不推动组框（回归：拖入/拖出后组框莫名上移几px）", () => {
    // 成员距组顶仅 20px（< GROUP_NODE_PADDING=40），但完全在框内：
    // refit 不得把框顶推上去（旧 union 规则会外扩 padding 后把框顶抬 20px）
    const g = group("g1", 100, 100, 800, 600);
    const members = [member("a", 40, 20, 300, 200, "g1")];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("贴边成员存在时，其他成员的归属变化也不移动组框", () => {
    const g = group("g1", 100, 100, 800, 600);
    const nearTop = member("a", 40, 20, 300, 200, "g1");
    const deep = member("b", 100, 200, 200, 100, "g1");
    expect(computeFittedGroupRect(g, [nearTop, deep])).toBeNull();
  });

  it("前置契约：空组即删，空成员数组为非法输入（不产生收缩）", () => {
    const g = group("g1", 123, 456, 800, 600);
    expect(computeFittedGroupRect(g, [])).toBeNull();
  });
});

describe("groupContainsPoint / findGroupAtPoint（组框为绝对坐标）", () => {
  it("组框内含边界命中，框外不命中", () => {
    const g = group("g", 0, 0, 100, 50);
    expect(groupContainsPoint(g, { x: 50, y: 25 })).toBe(true);
    expect(groupContainsPoint(g, { x: 100, y: 50 })).toBe(true);
    expect(groupContainsPoint(g, { x: 101, y: 25 })).toBe(false);
    expect(groupContainsPoint(g, { x: 50, y: -1 })).toBe(false);
  });

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

describe("isGroupMember / groupMembers（parentId 唯一口径）", () => {
  it("按 parentId 显式归属取成员，组节点与无关节点不参与", () => {
    const nodes = [
      member("a", 0, 0, 50, 50, "g"),
      member("b", 100, 0, 50, 50, "g"),
      member("x", 200, 0, 50, 50, "other"),
      node("y", 300, 0, 50, 50, { type: "text-node" }),
      group("g", 0, 0, 100, 100),
    ];
    expect(groupMembers(nodes, "g").map((n) => n.id)).toEqual(["a", "b"]);
    expect(groupMembers(nodes, "missing")).toEqual([]);
    expect(isGroupMember(nodes[0], "g")).toBe(true);
    expect(isGroupMember(nodes[4], "g")).toBe(false);
  });
});

describe("pruneEmptyGroups（空组即删）", () => {
  it("删除没有任何成员的组，有成员的组保留", () => {
    const nodes = [
      group("empty", 0, 0, 100, 100),
      member("a", 0, 0, 50, 50, "kept"),
      group("kept", 0, 0, 200, 200),
    ];
    const out = pruneEmptyGroups(nodes);
    expect(out.map((n) => n.id)).toEqual(["a", "kept"]);
  });

  it("无空组时返回原数组引用（零拷贝快路径）", () => {
    const nodes = [member("a", 0, 0, 50, 50, "g"), group("g", 0, 0, 100, 100)];
    expect(pruneEmptyGroups(nodes)).toBe(nodes);
  });

  it("没有组的数组返回原引用", () => {
    const nodes = [node("a", 0, 0, 50, 50, { type: "text-node" })];
    expect(pruneEmptyGroups(nodes)).toBe(nodes);
  });

  it("多个组只删空的，顺序保持不变", () => {
    const nodes = [
      group("g1", 0, 0, 100, 100),
      member("a", 0, 0, 50, 50, "g2"),
      group("g2", 0, 0, 100, 100),
      group("g3", 0, 0, 100, 100),
      member("b", 10, 10, 50, 50, "g1"),
    ];
    expect(pruneEmptyGroups(nodes).map((n) => n.id)).toEqual(["g1", "a", "g2", "b"]);
  });
});

describe("resolveDropGroupId（拖入归属判定：高亮与 drag stop 共用口径）", () => {
  // 组 g (0,0) 400×300，组 h (1000,0) 400×300；成员 100×50
  const g = group("g", 0, 0, 400, 300);
  const h = group("h", 1000, 0, 400, 300);
  const memberAt = (id: string, x: number, y: number, gid?: string) =>
    node(id, x, y, 100, 50, { type: "text-node", parentId: gid });

  it("成员中心（绝对坐标）仍在原组内：归属不变", () => {
    const m = memberAt("a", 100, 100, "g");
    expect(resolveDropGroupId(m, buildGroupHitIndex([g, h, m]))).toBe("g");
  });

  it("拖出原组到空白：返回 undefined（脱离）", () => {
    const m = memberAt("a", 600, 0, "g");
    expect(resolveDropGroupId(m, buildGroupHitIndex([g, h, m]))).toBeUndefined();
  });

  it("拖入另一组：返回目标组 id（拖入高亮宿主）", () => {
    const m = memberAt("a", 1150, 100, "g");
    expect(resolveDropGroupId(m, buildGroupHitIndex([g, h, m]))).toBe("h");
  });

  it("节点大部分面积在组内但中心在外：不归属（中心点口径）", () => {
    const onEdge = memberAt("a", 350, 100, undefined);
    expect(resolveDropGroupId(onEdge, buildGroupHitIndex([g, onEdge]))).toBe("g");
    const outside = memberAt("a", 355, 100, undefined);
    expect(resolveDropGroupId(outside, buildGroupHitIndex([g, outside]))).toBeUndefined();
  });

  it("原组已删（幽灵 parentId）：按落点重新判定，不因幽灵 id 兜底", () => {
    const m = memberAt("a", 1150, 100, "ghost");
    expect(resolveDropGroupId(m, buildGroupHitIndex([g, h, m]))).toBe("h");
  });
});

describe("refitGroupRects", () => {
  it("成员探出右侧时组框向右扩张，原点与贴边成员不动", () => {
    // 成员 rel(0,0) 尺寸 200×50：左/上不探出（x=0,y=0 不动），右侧探出
    // → 组框向右扩到 成员右缘 + padding，未探出侧的尺寸保持
    const m = member("a", 0, 0, 200, 50, "g1");
    const g1 = group("g1", 0, 0, 100, 150);
    const g2 = group("g2", 1000, 1000, 100, 100);
    const out = refitGroupRects([g1, g2, m], ["g1"]);
    const g1Out = out.find((n) => n.id === "g1")!;
    expect(g1Out.position.x).toBe(0);
    expect(g1Out.position.y).toBe(0);
    expect((g1Out.style as { width: number }).width).toBe(200 + GROUP_NODE_PADDING);
    expect((g1Out.style as { height: number }).height).toBe(150);
    // 未列出的组不动，非组节点原样
    expect(out.find((n) => n.id === "g2")).toBe(g2);
    expect(out.find((n) => n.id === "a")).toBe(m);
  });

  it("成员探出组顶/组左时组框上扩，全部成员视觉位置不变（回归：框动内容不动）", () => {
    // 组 (0,0) 400×300；成员 a 在框内，成员 b 刚拖入且探出组顶/组左 20px
    const g = group("g", 0, 0, 400, 300);
    const a = member("a", 100, 100, 200, 150, "g");
    const b = member("b", -20, -20, 200, 150, "g");
    const out = refitGroupRects([g, a, b], ["g"]);
    const gOut = out.find((n) => n.id === "g")!;
    const aOut = out.find((n) => n.id === "a")!;
    const bOut = out.find((n) => n.id === "b")!;
    // 组框上/左扩 60（探出 20 + padding 40），包住 b 并留 padding
    expect(gOut.position).toEqual({ x: -60, y: -60 });
    expect(gOut.style).toMatchObject({ width: 460, height: 360 });
    // 成员视觉位置（组原点 + 相对坐标）严格不变：框动内容不动
    const visual = (n: AnyNode, origin: { x: number; y: number }) => ({
      x: origin.x + n.position.x,
      y: origin.y + n.position.y,
    });
    expect(visual(aOut, gOut.position)).toEqual({ x: 100, y: 100 });
    expect(visual(bOut, gOut.position)).toEqual({ x: -20, y: -20 });
    // 被包裹成员距新框缘恰为 padding（成员相对坐标即到框缘距离）
    expect(bOut.position.x).toBe(GROUP_NODE_PADDING);
    expect(bOut.position.y).toBe(GROUP_NODE_PADDING);
  });

  it("成员已在组框内时该组保持原对象（无需变化）", () => {
    const m = member("a", 100, 100, 50, 50, "g1");
    const g1 = group("g1", 50, 50, 200, 200);
    const out = refitGroupRects([g1, m], ["g1"]);
    expect(out.find((n) => n.id === "g1")).toBe(g1);
  });
});
