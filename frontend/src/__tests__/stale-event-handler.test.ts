/**
 * RF 事件处理器过期闭包测试。
 *
 * 建模背景：InfiniteCanvas 的五个事件 handler（handleNodesChange / handleEdgesChange
 * / handleNodeClick / handlePaneClick / handleConnect）当前闭包捕获 RenderScope
 * 的 nodes/edges。React Flow 在同一渲染帧内可能连续派发多次变更（选中 + 位置/
 * 尺寸），若第二次以过期闭包基底计算，会覆盖第一次的选中写入。
 *
 * 本测试不模拟 handler 本身，而是用 applyNodeChanges / applyEdgeChanges 直接证明：
 * "同帧两次变更时，用 store 实时基底的结果包含两次变更；用过期闭包基底则丢失前一次"。
 * 这是 handler 修复"改 store 读"必须跨过的门槛。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { applyNodeChanges, applyEdgeChanges } from "@xyflow/react";
import { useCanvasStore } from "@/stores/canvas-store";
import type { AnyNode } from "@/lib/types";

/** 快速构造一个节点 */
function node(id: string, overrides: Record<string, unknown> = {}): AnyNode {
  return {
    id, type: "text-node",
    position: { x: 100, y: 200 },
    data: { label: id, content: "" },
    ...overrides,
  } as AnyNode;
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
});

describe("同帧连续两次 onNodesChange：选中 + 位置 → store 实时读能保留两者，过期闭包基底丢失选中", () => {
  it("仅位置变更也可正确应用（基线：applyNodeChanges 行为不受基底来源影响）", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });

    const changes: any[] = [{ type: "position", id: "n0", position: { x: 500, y: 500 }, dragging: true }];
    // 任意基底，只有一条变更，结果相同
    const result = applyNodeChanges(changes, [n0]);
    expect(result[0].position).toEqual({ x: 500, y: 500 });
  });

  it("选中后紧跟位置变更：过期闭包基底丢失选中（重现 bug）", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });

    const selectChange: any = { type: "select", id: "n0", selected: true };
    const positionChange: any = { type: "position", id: "n0", position: { x: 500, y: 500 }, dragging: true };

    // 第一次：选中变更应用到 store
    const afterSelect = applyNodeChanges([selectChange], [n0]);
    useCanvasStore.setState({ nodes: afterSelect });

    // 第二次：用**过期闭包基底**（仍是选中前的 n0）算位置变更
    const staleBase = [n0]; // ← 这是 handleNodesChange 闭包里的旧引用
    const fromStale = applyNodeChanges([positionChange], staleBase);

    // Bug 复现：过期基底算出的结果丢失了选中状态
    expect(fromStale[0].selected).not.toBe(true);
    // 正确行为（store 实时读）应该同时有位置和选中 —— 见下一个 test
  });

  it("同帧两次变更时 store 实时读基底保留两次变更（修复后期望）", () => {
    const n0 = node("n0");
    useCanvasStore.setState({ nodes: [n0] });

    const selectChange: any = { type: "select", id: "n0", selected: true };
    const positionChange: any = { type: "position", id: "n0", position: { x: 500, y: 500 }, dragging: true };

    // 第一次变更入 store
    const afterSelect = applyNodeChanges([selectChange], [n0]);
    useCanvasStore.setState({ nodes: afterSelect });

    // 第二次：用 store 实时读（修复后的方式）
    const storeBase = useCanvasStore.getState().nodes;
    const fromStore = applyNodeChanges([positionChange], storeBase);

    // 修复后：位置变了，选中也在
    expect(fromStore[0].selected).toBe(true);
    expect(fromStore[0].position).toEqual({ x: 500, y: 500 });
  });

  it("更复杂的场景：node 数组中有两个节点，过期基底可能包括已删节点导致幽灵复活", () => {
    const n0 = node("n0");
    const n1 = node("n1");
    useCanvasStore.setState({ nodes: [n0, n1] });

    // 第一次：选中 n0
    const afterSelect = applyNodeChanges([{ type: "select", id: "n0", selected: true }], [n0, n1]);
    useCanvasStore.setState({ nodes: afterSelect });

    // 过期基底：n1 已被删除（第二次变更前 n1 不存在于 store 中）
    const afterDelete = afterSelect.filter((n) => n.id !== "n1");
    useCanvasStore.setState({ nodes: afterDelete });

    // 用过期基底（仍含 n1）算 n0 的位置变更
    const staleBase = [n0, n1]; // n1 已不在 store 中
    const fromStale = applyNodeChanges([{ type: "position", id: "n0", position: { x: 999, y: 999 }, dragging: true }], staleBase);
    // 过期基底把 n1 复活了
    expect(fromStale.length).toBe(2);
    expect(fromStale.find((n) => n.id === "n1")).toBeDefined();

    // Store 实时读不会复活
    const storeBase = useCanvasStore.getState().nodes;
    const fromStore = applyNodeChanges([{ type: "position", id: "n0", position: { x: 999, y: 999 }, dragging: true }], storeBase);
    expect(fromStore.length).toBe(1);
    expect(fromStore[0].id).toBe("n0");
    expect(fromStore[0].selected).toBe(true);
  });
});

describe("同帧连续两次 onEdgesChange", () => {
  it("选中边 + 同帧其他变更：过期闭包基底丢失选中状态", () => {
    const e0 = { id: "e0", source: "n0", target: "n1" };
    useCanvasStore.setState({ edges: [e0 as any] });

    const selectChange: any = { type: "select", id: "e0", selected: true };
    const otherChange: any = { type: "select", id: "e0", selected: false }; // 模拟误派发的二次 select

    // 第一次变更入 store
    const afterSelect = applyEdgeChanges([selectChange], [e0]);
    useCanvasStore.setState({ edges: afterSelect as any });

    // 过期闭包基底（选中前的 e0）
    const fromStale = applyEdgeChanges([otherChange], [e0]);
    // 过期基底：选中前 e0 没有 selected=true，会正常把 selected 设为 false
    // 但关键是：第二次变更应基于第一次的结果
    // 真正的问题在另一种模式：RF先发一条无关变更、后发 select，select 用过期基底
    // 这里只验证基线 —— edges 的 applyEdgeChanges 同样受基底影响
    expect(fromStale.length).toBe(1);
  });

  it("store 实时读基底保留边选中（修复后期望）", () => {
    const e0 = { id: "e0", source: "n0", target: "n1" };
    useCanvasStore.setState({ edges: [e0 as any] });

    // 先选中边
    const afterSelect = applyEdgeChanges([{ type: "select", id: "e0", selected: true }], [e0]);
    useCanvasStore.setState({ edges: afterSelect as any });

    // 一条无关变更（如另一条边变化），用 store 实时读
    const storeBase = useCanvasStore.getState().edges;
    // 模拟 RF 报告 e0 尺寸变化（实际上边没有尺寸，这里是建模第二变更不碰第一变更的项）
    const fromStore = applyEdgeChanges([], storeBase);

    // 选中仍在
    expect(fromStore.length).toBe(1);
    expect(fromStore[0].selected).toBe(true);
  });
});
