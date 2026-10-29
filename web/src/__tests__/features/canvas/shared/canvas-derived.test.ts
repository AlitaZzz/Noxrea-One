import { describe, expect, it } from "vitest";

import {
  getCanvasDerived,
  getCanvasOutline,
  getNodeUpstreamRefs,
} from "@/features/canvas/shared/canvas-derived";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

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

  it("reuses upstream refs across position-only updates", () => {
    const edges = [
      { id: "e1", source: "img", target: "gen" },
      { id: "e2", source: "txt", target: "gen" },
    ] as const;
    const nodes: AnyNode[] = [
      { ...node("img", 0), type: NODE_TYPE.IMAGE, data: { src: "s1" } } as AnyNode,
      { ...node("txt", 200), type: NODE_TYPE.TEXT, data: { plainText: "hi" } } as AnyNode,
      { ...node("gen", 400), type: NODE_TYPE.IMAGE, data: {} } as AnyNode,
    ];

    const first = getNodeUpstreamRefs(nodes, [...edges], "gen");
    const moved = nodes.map((item) => ({
      ...item,
      position: { ...item.position, x: item.position.x + 12 },
    }));
    expect(getNodeUpstreamRefs(moved, [...edges], "gen")).toBe(first);
    expect(first.images).toEqual(["s1"]);
    expect(first.texts).toEqual([{ id: "txt", content: "hi" }]);

    // 数据变化必须产生新的投影
    const edited: AnyNode[] = nodes.map((item) =>
      item.id === "txt" ? ({ ...item, data: { plainText: "bye" } } as AnyNode) : item,
    );
    const next = getNodeUpstreamRefs(edited, [...edges], "gen");
    expect(next).not.toBe(first);
    expect(next.texts).toEqual([{ id: "txt", content: "bye" }]);
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
