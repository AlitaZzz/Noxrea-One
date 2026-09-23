/**
 * 用户操作感知（user-action-tracker）回归测试。
 *
 * 锁住核心语义：
 * 1. 拖拽逐帧变更合并为一条 before→after（增量 squash）
 * 2. 新增后删除自动抵消；改了又改回原样不产生噪音 diff
 * 3. agent 执行期间（agentActing）与程序化写回（suppress）不记录
 * 4. 纯 selection 变化不产生 diff（选择走快照实时读取，不进动作历史）
 * 5. drain 取走全部并清空，二次 drain 为空
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  beginAgentActing,
  clearUserActions,
  drainUserActions,
  endAgentActing,
  runSuppressed,
} from "@/features/canvas/agent/user-action-tracker";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";

function textNode(id: string, x = 0, y = 0, plainText = "hello"): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x, y },
    data: { label: `节点${id}`, plainText },
    style: { width: 200, height: 120 },
    selected: false,
  } as unknown as AnyNode;
}

function edge(id: string, source: string, target: string): AnyEdge {
  return { id, source, target } as unknown as AnyEdge;
}

function setNodes(nodes: AnyNode[]): void {
  useCanvasStore.setState({ nodes });
}

function setEdges(edges: AnyEdge[]): void {
  useCanvasStore.setState({ edges });
}

function findUpdated(id: string) {
  return drainOnce()?.updated.find((u) => u.id === id);
}

function drainOnce() {
  return drainUserActions();
}

describe("用户操作感知 tracker", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
    clearUserActions();
  });

  it("拖拽逐帧变更合并为一条首→尾记录", () => {
    setNodes([textNode("t1", 0, 0)]);
    drainOnce();

    setNodes([textNode("t1", 10, 0)]);
    setNodes([textNode("t1", 10, 20)]);
    setNodes([textNode("t1", 300, 400)]);

    const payload = drainOnce();
    expect(payload?.updated).toHaveLength(1);
    expect(payload?.updated[0].changes.position).toEqual({ from: [0, 0], to: [300, 400] });
  });

  it("新增后删除自动抵消（同一 drain 窗口内）", () => {
    setNodes([textNode("t1")]);
    setNodes([textNode("t1"), textNode("t2", 50, 50)]);
    setNodes([textNode("t1")]);

    const payload = drainOnce();
    // t2 增删净值为零；t1 是本窗口真实的新增
    expect(payload?.added.map((a) => a.id)).toEqual(["t1"]);
    expect(payload?.removed).toHaveLength(0);
  });

  it("删除已有节点后又加回：跨 drain 记为新增", () => {
    setNodes([textNode("t1")]);
    drainOnce();
    setNodes([]);
    expect(drainOnce()?.removed).toHaveLength(1);

    setNodes([textNode("t1")]);
    expect(drainOnce()?.added.map((a) => a.id)).toEqual(["t1"]);
  });

  it("删除已有节点记 removed，带摘要", () => {
    setNodes([textNode("t1")]);
    drainOnce();
    setNodes([]);
    const payload = drainOnce();
    expect(payload?.removed).toHaveLength(1);
    expect(payload?.removed[0]).toMatchObject({ id: "t1", type: "text-node", summary: "节点t1" });
  });

  it("改了又改回原样：不产生 diff", () => {
    setNodes([textNode("t1")]);
    drainOnce();

    setNodes([textNode("t1", 0, 0, "改了")]);
    setNodes([textNode("t1", 0, 0, "hello")]);

    expect(drainOnce()).toBeNull();
  });

  it("agent 执行期间（agentActing）的写回不记录", () => {
    setNodes([textNode("t1")]);
    drainOnce();

    beginAgentActing();
    try {
      setNodes([textNode("t1", 999, 999)]);
    } finally {
      endAgentActing();
    }
    expect(drainOnce()).toBeNull();
  });

  it("suppress 可嵌套，全部退出后恢复记录", () => {
    setNodes([textNode("t1")]);
    drainOnce();

    runSuppressed(() => {
      setNodes([textNode("t1", 100, 0)]);
      runSuppressed(() => setNodes([textNode("t1", 200, 0)]));
    });
    expect(drainOnce()).toBeNull();

    // suppress 结束后恢复跟踪
    setNodes([textNode("t1", 300, 0)]);
    expect(drainOnce()?.updated[0].changes.position).toEqual({ from: [200, 0], to: [300, 0] });
  });

  it("纯 selection 翻转不产生 diff", () => {
    const n = textNode("t1");
    setNodes([n]);
    drainOnce();

    setNodes([{ ...n, selected: true }]);
    setNodes([{ ...n, selected: false }]);

    expect(drainOnce()).toBeNull();
  });

  it("内容与尺寸变更分别记录；src 出现记 srcSet", () => {
    const n = textNode("t1") as AnyNode & { data: Record<string, unknown> };
    setNodes([n]);
    drainOnce();

    const grown = { ...n, style: { width: 400, height: 300 }, data: { ...n.data, plainText: "新内容", src: "https://cdn/a.png" } };
    setNodes([grown as unknown as AnyNode]);

    const changes = findUpdated("t1")?.changes;
    expect(changes).toMatchObject({
      size: { from: [200, 120], to: [400, 300] },
      content: { from: "hello", to: "新内容" },
      srcSet: true,
    });
  });

  it("连线增删：删→加→删净值为零；删除已有连线记 removed", () => {
    setNodes([textNode("t1"), textNode("t2", 100, 100)]);
    setEdges([edge("e1", "t1", "t2")]);
    drainOnce();

    setEdges([]);
    const payload = drainOnce();
    expect(payload?.edges.removed).toEqual([{ source: "t1", target: "t2" }]);

    // 同一窗口内删→加→删：净值为零
    setEdges([edge("e1", "t1", "t2")]);
    setEdges([]);
    expect(drainOnce()).toBeNull();

    // 加→删→加：净值为 added
    setEdges([edge("e1", "t1", "t2")]);
    setEdges([]);
    setEdges([edge("e1", "t1", "t2")]);
    const addedPayload = drainOnce();
    expect(addedPayload?.edges.added).toEqual([{ source: "t1", target: "t2" }]);
    expect(addedPayload?.edges.removed).toHaveLength(0);
  });

  it("drain 后清空：二次 drain 为 null", () => {
    setNodes([textNode("t1")]);
    const first = drainOnce();
    expect(first?.added).toHaveLength(1);
    expect(drainOnce()).toBeNull();
  });
});
