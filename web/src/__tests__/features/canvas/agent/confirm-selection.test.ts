/**
 * 确认勾选子集改写测试：nodeIds 替换 / edgeIndexes 过滤 / 全选原样 / 勾空丢弃。
 */
import { describe, expect, it } from "vitest";

import {
  applyConfirmSelections,
  collectConfirmTargetNodeIds,
} from "@/features/canvas/agent/utils/confirm-selection";
import type { AgentToolCall } from "@/features/canvas/agent/types";

describe("applyConfirmSelections", () => {
  it("无 selections 时原样返回", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a", "b"] } },
    ];
    const out = applyConfirmSelections(calls);
    expect(out.calls).toEqual(calls);
    expect(out.skipped).toEqual({});
    expect(out.dropped).toEqual([]);
  });

  it("delete_nodes 按勾选保留 nodeIds 子集", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a", "b", "c"], intent: "删除" } },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["a", "c"] } });
    expect(out.calls[0].args.nodeIds).toEqual(["a", "c"]);
    expect(out.calls[0].args.intent).toBe("删除");
    expect(out.skipped).toEqual({ c1: 1 });
    expect(out.dropped).toEqual([]);
  });

  it("delete_edges 按 edgeIndexes 过滤原数组（含重复对时不歧义）", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_edges", args: { edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }] } },
    ];
    const out = applyConfirmSelections(calls, { c1: { edgeIndexes: [1] } });
    expect(out.calls[0].args.edges).toEqual([{ source: "b", target: "a" }]);
    expect(out.skipped).toEqual({ c1: 1 });
  });

  it("全部勾空时该调用被丢弃", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a", "b"] } },
      { id: "c2", name: "arrange_canvas", args: {} },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: [] } });
    expect(out.calls.map((c) => c.id)).toEqual(["c2"]);
    expect(out.skipped).toEqual({ c1: 2 });
    expect(out.dropped).toEqual(["c1"]);
  });

  it("未勾选的调用原样执行", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["a"] } },
      { id: "c2", name: "delete_nodes", args: { nodeIds: ["b"] } },
    ];
    const out = applyConfirmSelections(calls, { c1: { nodeIds: ["a"] } });
    expect(out.calls).toHaveLength(2);
    expect(out.calls[1].args.nodeIds).toEqual(["b"]);
  });
});

describe("collectConfirmTargetNodeIds", () => {
  it("delete_nodes 取 nodeIds，delete_edges 取两端去重，arrange_canvas 取全部节点", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_edges", args: { edges: [{ source: "n1", target: "n2" }] } },
      { id: "c2", name: "arrange_canvas", args: {} },
    ];
    const ids = collectConfirmTargetNodeIds(calls, ["n1", "n2", "n3"]);
    expect(new Set(ids)).toEqual(new Set(["n1", "n2", "n3"]));
  });

  it("delete_nodes 只取其 nodeIds", () => {
    const calls: AgentToolCall[] = [
      { id: "c1", name: "delete_nodes", args: { nodeIds: ["n2", "n3"] } },
    ];
    expect(collectConfirmTargetNodeIds(calls, ["n1", "n2", "n3"])).toEqual(["n2", "n3"]);
  });
});
