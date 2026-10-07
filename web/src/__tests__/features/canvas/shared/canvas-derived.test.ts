import { describe, expect, it } from "vitest";

import { getCanvasDerived } from "@/features/canvas/shared/canvas-derived";
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
    expect(second.outline).toBe(first.outline);
    expect(second.selectionFrame).toBeNull();
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
