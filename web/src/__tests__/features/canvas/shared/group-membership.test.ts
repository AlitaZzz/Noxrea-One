/**
 * group-membership 测试：成员归属唯一口径（parentId 显式归属、组不嵌套）
 * 与空组即删。
 */

import { describe, expect, it } from "vitest";

import {
  groupMembers,
  isGroupMember,
  isGroupNode,
  memberParentId,
  pruneEmptyGroups,
} from "@/features/canvas/shared/group-membership";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function node(id: string, extra?: Record<string, unknown>): AnyNode {
  return { id, position: { x: 0, y: 0 }, data: {}, ...extra } as unknown as AnyNode;
}

function group(id: string): AnyNode {
  return node(id, { type: NODE_TYPE.GROUP });
}

/** 组成员：position 为组内相对坐标，parentId 指向组 */
function member(id: string, gid: string): AnyNode {
  return node(id, { type: "text-node", parentId: gid });
}

function topLevel(id: string): AnyNode {
  return node(id, { type: "text-node" });
}

describe("归属原语（isGroupNode / memberParentId / isGroupMember）", () => {
  it("只有非组节点带 parentId 时才有归属父", () => {
    const g = group("g");
    expect(isGroupNode(g)).toBe(true);
    expect(memberParentId(g)).toBeUndefined();
    expect(memberParentId(topLevel("t"))).toBeUndefined();
    expect(memberParentId(member("m", "g"))).toBe("g");
  });

  it("组节点即使带 parentId 也不参与成员归属（组不嵌套）", () => {
    const nested = node("nested", { type: NODE_TYPE.GROUP, parentId: "g" });
    expect(memberParentId(nested)).toBeUndefined();
    expect(isGroupMember(nested, "g")).toBe(false);
  });
});

describe("groupMembers（parentId 唯一口径）", () => {
  it("按 parentId 显式归属取成员，组节点与无关节点不参与", () => {
    const nodes = [
      member("a", "g"),
      member("b", "g"),
      member("x", "other"),
      topLevel("y"),
      group("g"),
    ];
    expect(groupMembers(nodes, "g").map((n) => n.id)).toEqual(["a", "b"]);
    expect(groupMembers(nodes, "missing")).toEqual([]);
    expect(isGroupMember(nodes[0], "g")).toBe(true);
    expect(isGroupMember(nodes[4], "g")).toBe(false);
  });
});

describe("pruneEmptyGroups（空组即删）", () => {
  it("删除没有任何成员的组，有成员的组保留", () => {
    const nodes = [group("empty"), member("a", "kept"), group("kept")];
    expect(pruneEmptyGroups(nodes).map((n) => n.id)).toEqual(["a", "kept"]);
  });

  it("无空组时返回原数组引用（零拷贝快路径）", () => {
    const nodes = [member("a", "g"), group("g")];
    expect(pruneEmptyGroups(nodes)).toBe(nodes);
  });

  it("没有组的数组返回原引用", () => {
    const nodes = [topLevel("a")];
    expect(pruneEmptyGroups(nodes)).toBe(nodes);
  });

  it("多个组只删空的，顺序保持不变", () => {
    const nodes = [group("g1"), member("a", "g2"), group("g2"), group("g3"), member("b", "g1")];
    expect(pruneEmptyGroups(nodes).map((n) => n.id)).toEqual(["g1", "a", "g2", "b"]);
  });
});
