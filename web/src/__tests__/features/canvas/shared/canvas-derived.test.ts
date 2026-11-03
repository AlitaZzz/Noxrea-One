import { describe, expect, it } from "vitest";

import {
  getCanvasDerived,
  getCanvasOutline,
  selectCanvasToolbarMode,
} from "@/features/canvas/shared/canvas-derived";
import type { AnyNode } from "@/features/canvas/types";

function node(id: string, x: number, selected = false, parentId?: string): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x, y: 0 },
    selected,
    parentId,
    data: { label: id },
    style: { width: 100, height: 60 },
  } as AnyNode;
}

describe("canvas-derived", () => {
  it("reuses the projection and stable set references for position-only updates", () => {
    const edges = [{ id: "e1", source: "a", target: "b" }];
    const nodes = [node("a", 0, true), node("b", 240)];
    const first = getCanvasDerived(nodes, edges);
    const moved = nodes.map((item) => ({ ...item, position: { ...item.position, x: item.position.x + 12 } }));
    const second = getCanvasDerived(moved, edges);

    expect(getCanvasDerived(nodes, edges)).toBe(first);
    expect(second.selectedNodeIds).toBe(first.selectedNodeIds);
    expect(second.highlightedEdgeIds).toBe(first.highlightedEdgeIds);
    expect(second.selectionFrame).toBeNull();
    // 元素树大纲不再进入位置帧投影，按结构键缓存即可复用同一引用
    expect(getCanvasOutline(moved)).toBe(getCanvasOutline(nodes));
  });

  it("builds the aggregate toolbar bounds from every selected node, groups included", () => {
    const group = {
      id: "g",
      type: "group-node",
      position: { x: 10, y: 20 },
      selected: true,
      data: { label: "group" },
      style: { width: 300, height: 200 },
    } as AnyNode;
    const member = node("m", 40, true, "g");
    const derived = getCanvasDerived([group, member], []);

    expect(derived.selectionChromeBounds).toEqual({
      count: 2,
      hasGroup: true,
      bbox: { x: 10, y: 20, width: 300, height: 200 },
      frameVisible: true,
      // 工具条锚点：并集四边外扩 40px，顶部再加标题带 28px
      containerBbox: { x: -30, y: -48, width: 380, height: 308 },
    });
    // 批量连线的选区外框只统计非组节点，不覆盖这个场景
    expect(derived.selectionFrame).toBeNull();
  });

  it("unions all selected nodes and reports group presence", () => {
    const group = {
      id: "g",
      type: "group-node",
      position: { x: 400, y: 50 },
      selected: true,
      data: { label: "group" },
      style: { width: 200, height: 100 },
    } as AnyNode;
    const loose: AnyNode = { ...node("n", 0, true), position: { x: 0, y: 0 } };
    const unselected = node("x", 900);
    const derived = getCanvasDerived([group, loose, unselected], []);

    expect(derived.selectionChromeBounds).toEqual({
      count: 2,
      hasGroup: true,
      bbox: { x: 0, y: 0, width: 600, height: 150 },
      frameVisible: true,
      containerBbox: { x: -40, y: -68, width: 680, height: 258 },
    });
  });

  it("reserves a title band above the visible frame for the toolbar anchor", () => {
    const derived = getCanvasDerived([node("a", 100, true), node("b", 300, true)], []);

    expect(derived.selectionChromeBounds).toEqual({
      count: 2,
      hasGroup: false,
      bbox: { x: 100, y: 0, width: 300, height: 60 },
      frameVisible: true,
      containerBbox: { x: 60, y: -68, width: 380, height: 168 },
    });
  });

  it("hides the selection frame and anchors to the group union when every selected node is a group", () => {
    const first = {
      id: "g1",
      type: "group-node",
      position: { x: 0, y: 0 },
      selected: true,
      data: { label: "g1" },
      style: { width: 200, height: 100 },
    } as AnyNode;
    const second = {
      id: "g2",
      type: "group-node",
      position: { x: 400, y: 50 },
      selected: true,
      data: { label: "g2" },
      style: { width: 200, height: 100 },
    } as AnyNode;
    const derived = getCanvasDerived([first, second], []);

    expect(derived.selectionChromeBounds).toEqual({
      count: 2,
      hasGroup: true,
      bbox: { x: 0, y: 0, width: 600, height: 150 },
      frameVisible: false,
      containerBbox: { x: 0, y: 0, width: 600, height: 150 },
    });
  });

  it("returns no aggregate bounds for fewer than two selected nodes", () => {
    expect(getCanvasDerived([node("a", 0, true), node("b", 200)], []).selectionChromeBounds).toBeNull();
    expect(getCanvasDerived([node("a", 0)], []).selectionChromeBounds).toBeNull();
  });

  it("selects the toolbar mode from interaction gating and the aggregate projection", () => {
    const bounds = getCanvasDerived([node("a", 0, true), node("b", 200, true)], [])
      .selectionChromeBounds!;

    // 交互门控关闭（框选手势 / 拖动）优先于选区状态
    expect(selectCanvasToolbarMode(false, bounds)).toEqual({ kind: "hidden" });
    expect(selectCanvasToolbarMode(false, null)).toEqual({ kind: "hidden" });
    // ≥2 选中 → 聚合工具条，并携带锚点
    expect(selectCanvasToolbarMode(true, bounds)).toEqual({ kind: "aggregate", bounds });
    // 0/1 选中 → per-node（是否真的渲染由节点自身规则决定）
    expect(selectCanvasToolbarMode(true, null)).toEqual({ kind: "per-node" });
  });

  it("builds one shared rail projection for every rail consumer", () => {
    const group = {
      id: "g",
      type: "group-node",
      position: { x: 0, y: 0 },
      data: { label: "group" },
      style: { width: 300, height: 200 },
    } as AnyNode;
    const member = node("m", 140, false, "g");
    const derived = getCanvasDerived([group, member], []);

    expect(derived.railWidths.get("m:right")).toBe(60);
    expect(derived.railWidths.get("m:left")).toBe(80);
  });
});
