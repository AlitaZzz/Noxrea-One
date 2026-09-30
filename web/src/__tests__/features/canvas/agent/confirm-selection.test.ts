/**
 * 确认勾选子集改写测试：nodeIds 替换 / edgeIndexes 过滤 / 全选原样 / 勾空丢弃，
 * 以及容器型组语义（删组连带成员）下的展开与勾选翻译。
 */
import { describe, expect, it } from "vitest";

import type { AgentToolCall } from "@/features/canvas/agent/types";
import {
  applyConfirmSelections,
  collectConfirmTargetNodeIds,
  expandGroupDeletionIds,
} from "@/features/canvas/agent/utils/confirm-selection";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** 无组的节点场景（容器语义不参与时行为不变） */
const plainNodes = ["n1", "n2", "n3", "a", "b", "c"].map((id) => ({
  id,
  type: "text-node",
  position: { x: 0, y: 0 },
  data: { label: id },
})) as unknown as AnyNode[];

/** 组 g1 成员 m1/m2；组 g2 成员 m3（成员归属 = parentId） */
const groupedNodes = [
  { id: "g1", type: NODE_TYPE.GROUP, position: { x: 0, y: 0 }, data: {} },
  { id: "g2", type: NODE_TYPE.GROUP, position: { x: 0, y: 0 }, data: {} },
  { id: "m1", type: "text-node", position: { x: 0, y: 0 }, parentId: "g1", data: {} },
  { id: "m2", type: "text-node", position: { x: 0, y: 0 }, parentId: "g1", data: {} },
  { id: "m3", type: "text-node", position: { x: 0, y: 0 }, parentId: "g2", data: {} },
  { id: "free", type: "text-node", position: { x: 0, y: 0 }, data: {} },
] as unknown as AnyNode[];

describe("expandGroupDeletionIds", () => {
  it("组 id 展开为组 + 全体成员，非组 id 原样，去重保序", () => {
    expect(expandGroupDeletionIds(groupedNodes, ["g1", "free", "m1"])).toEqual([
      "g1", "free", "m1", "m2",
    ]);
  });
});

describe("applyConfirmSelections", () => {
  it("无 selections 时原样返回", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a", "b"] } },
    ];
    const out = applyConfirmSelections(calls, undefined, plainNodes);
    expect(out.calls).toEqual(calls);
    expect(out.skipped).toEqual({});
    expect(out.dropped).toEqual([]);
  });

  it("delete_nodes 按勾选保留 nodeIds 子集", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a", "b", "c"], intent: "删除" } },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["a", "c"] } }, plainNodes);
    expect(out.calls[0].args.nodeIds).toEqual(["a", "c"]);
    expect(out.calls[0].args.intent).toBe("删除");
    expect(out.skipped).toEqual({ c1: 1 });
    expect(out.dropped).toEqual([]);
  });

  it("delete_edges 按 edgeIndexes 过滤原数组（含重复对时不歧义）", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_edges", args: { edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }] } },
    ];
    const out = applyConfirmSelections(calls, { c1: { edgeIndexes: [1] } }, plainNodes);
    expect(out.calls[0].args.edges).toEqual([{ source: "b", target: "a" }]);
    expect(out.skipped).toEqual({ c1: 1 });
  });

  it("全部勾空时该调用被丢弃", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a", "b"] } },
      { id: "c2", name: "arrange_canvas", args: {} },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: [] } }, plainNodes);
    expect(out.calls.map((c) => c.id)).toEqual(["c2"]);
    expect(out.skipped).toEqual({ c1: 2 });
    expect(out.dropped).toEqual(["c1"]);
  });

  it("未勾选的调用原样执行", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a"] } },
      { id: "c2", name: "delete_nodes", args: { nodeIds: ["b"] } },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["a"] } }, plainNodes);
    expect(out.calls).toHaveLength(2);
    expect(out.calls[1].args.nodeIds).toEqual(["b"]);
  });
});

describe("applyConfirmSelections（容器型：删组连带成员）", () => {
  it("组被勾：保留组 id（成员随容器级联，不单列），skipped 按展开集计", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["g1"] } },
    ];
    // 展开集 [g1, m1, m2]，用户勾掉 m2（组保留时成员勾选不改变结果）
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["g1", "m1"] } }, groupedNodes);
    expect(out.calls[0].args.nodeIds).toEqual(["g1"]);
    expect(out.skipped).toEqual({ c1: 1 });
  });

  it("组未勾、成员被勾：成员单独进生效参数（组清空后自动随之移除）", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["g1"] } },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["m1"] } }, groupedNodes);
    expect(out.calls[0].args.nodeIds).toEqual(["m1"]);
    expect(out.skipped).toEqual({ c1: 2 });
  });

  it("组与成员混编：勾组只留组，未勾组的成员按勾选保留", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["g1", "free"] } },
    ];
    // 展开集 [g1, free, m1, m2]；勾了 free + m1，未勾 g1
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["free", "m1"] } }, groupedNodes);
    expect(new Set(out.calls[0].args.nodeIds as string[])).toEqual(new Set(["free", "m1"]));
    expect(out.skipped).toEqual({ c1: 2 });
  });

  it("展开集全勾空：丢弃该调用", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["g1"] } },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: [] } }, groupedNodes);
    expect(out.calls).toEqual([]);
    expect(out.dropped).toEqual(["c1"]);
    expect(out.skipped).toEqual({ c1: 3 });
  });
});

describe("collectConfirmTargetNodeIds", () => {
  it("delete_nodes 取 nodeIds 容器型展开，delete_edges 取两端去重，arrange_canvas 取全部节点", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["g2"] } },
      { id: "c2", name: "delete_edges", args: { edges: [{ source: "m1", target: "free" }] } },
      { id: "c3", name: "arrange_canvas", args: {} },
    ];
    const ids = collectConfirmTargetNodeIds(calls, groupedNodes);
    // arrange_canvas 贡献全部节点 id，delete_nodes 的 g2 额外展开出 m3
    expect(new Set(ids)).toEqual(new Set(["g1", "g2", "m1", "m2", "m3", "free"]));
  });

  it("非组节点不做展开", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["m1", "free"] } },
    ];
    expect(collectConfirmTargetNodeIds(calls, groupedNodes)).toEqual(["m1", "free"]);
  });
});
