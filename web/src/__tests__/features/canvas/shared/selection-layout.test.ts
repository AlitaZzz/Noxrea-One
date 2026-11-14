/**
 * 选区级布局纯函数：单元收集、单元间边映射、四种模式、中心锚定与幂等。
 * 规则见 specs/canvas-multi-selection-layout.md 4.2–4.5。
 */
import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import type { CanvasLayoutMode } from "@/features/canvas/shared/layout-modes";
import {
  collectSelectionLayoutUnits,
  computeSelectionLayout,
  type SelectionLayoutUnit,
  selectionLinks,
} from "@/features/canvas/shared/selection-layout";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function node(
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 120,
  options: { type?: string; parentId?: string } = {},
): AnyNode {
  return {
    id,
    type: options.type ?? NODE_TYPE.VIDEO,
    position: { x, y },
    style: { width, height },
    data: { label: id },
    parentId: options.parentId,
  } as unknown as AnyNode;
}

function group(id: string, x: number, y: number, width = 400, height = 300): AnyNode {
  return node(id, x, y, width, height, { type: NODE_TYPE.GROUP });
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

function applyPositions(
  nodes: readonly AnyNode[],
  positions: Map<string, { x: number; y: number }>,
): AnyNode[] {
  return nodes.map((n) => ({
    ...n,
    position: positions.get(n.id) ?? n.position,
  })) as AnyNode[];
}

function centerOf(units: readonly SelectionLayoutUnit[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const unit of units) {
    minX = Math.min(minX, unit.x);
    minY = Math.min(minY, unit.y);
    maxX = Math.max(maxX, unit.x + unit.width);
    maxY = Math.max(maxY, unit.y + unit.height);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function unitCenter(
  units: readonly SelectionLayoutUnit[],
  positions: Map<string, { x: number; y: number }>,
) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const unit of units) {
    const p = positions.get(unit.id)!;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + unit.width);
    maxY = Math.max(maxY, p.y + unit.height);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

const MODES: CanvasLayoutMode[] = ["smart", "grid", "horizontal", "vertical"];

describe("collectSelectionLayoutUnits", () => {
  it("treats selected groups and top-level nodes as units", () => {
    const nodes = [
      group("g1", 0, 0),
      node("m1", 20, 40, 200, 120, { parentId: "g1" }),
      node("a", 800, 0),
      group("g2", 0, 600),
      node("m2", 20, 40, 200, 120, { parentId: "g2" }),
    ];
    const units = collectSelectionLayoutUnits(nodes, new Set(["g1", "a", "g2"]));

    expect(units.map((unit) => unit.id)).toEqual(["g1", "a", "g2"]);
    expect(units[0].memberIds).toEqual(["m1"]);
    expect(units[2].memberIds).toEqual(["m2"]);
  });

  it("dedupes members whose parent group is selected", () => {
    const nodes = [
      group("g", 0, 0),
      node("m1", 20, 40, 200, 120, { parentId: "g" }),
      node("m2", 240, 40, 200, 120, { parentId: "g" }),
    ];
    const units = collectSelectionLayoutUnits(nodes, new Set(["g", "m1", "m2"]));

    expect(units).toHaveLength(1);
    expect(units[0].id).toBe("g");
    expect(units[0].memberIds).toEqual(["m1", "m2"]);
  });

  it("ignores selected members whose parent group is not selected", () => {
    const nodes = [
      group("g", 0, 0),
      node("m", 20, 40, 200, 120, { parentId: "g" }),
      node("a", 800, 0),
    ];
    const units = collectSelectionLayoutUnits(nodes, new Set(["m", "a"]));

    expect(units.map((unit) => unit.id)).toEqual(["a"]);
  });

  it("returns no units when only members of an unselected group are selected", () => {
    const nodes = [
      group("g", 0, 0),
      node("m1", 20, 40, 200, 120, { parentId: "g" }),
      node("m2", 240, 40, 200, 120, { parentId: "g" }),
    ];
    expect(collectSelectionLayoutUnits(nodes, new Set(["m1", "m2"]))).toEqual([]);
  });

  it("treats dangling or non-group parentId as top-level", () => {
    const nodes = [
      node("a", 0, 0, 200, 120, { parentId: "ghost" }),
      node("parent", 400, 0),
      node("b", 800, 0, 200, 120, { parentId: "parent" }),
    ];
    const units = collectSelectionLayoutUnits(nodes, new Set(["a", "b"]));

    expect(units.map((unit) => unit.id)).toEqual(["a", "b"]);
  });

  it("keeps empty groups as units", () => {
    const units = collectSelectionLayoutUnits([group("g", 0, 0)], new Set(["g"]));
    expect(units.map((unit) => unit.id)).toEqual(["g"]);
    expect(units[0].memberIds).toEqual([]);
  });
});

describe("selectionLinks", () => {
  const units: SelectionLayoutUnit[] = [
    { id: "g1", x: 0, y: 0, width: 400, height: 300, memberIds: ["m1"] },
    { id: "g2", x: 0, y: 400, width: 400, height: 300, memberIds: ["m2"] },
    { id: "a", x: 800, y: 0, width: 200, height: 120, memberIds: [] },
  ];

  it("maps member endpoints to their group unit", () => {
    expect(selectionLinks(units, [edge("m1", "m2")])).toEqual([["g1", "g2"]]);
    expect(selectionLinks(units, [edge("m1", "a")])).toEqual([["g1", "a"]]);
  });

  it("filters self-loops, same-unit links and dangling endpoints", () => {
    expect(selectionLinks(units, [edge("m1", "m1")])).toEqual([]);
    expect(selectionLinks(units, [edge("m1", "ghost")])).toEqual([]);
    expect(selectionLinks(units, [edge("ghost", "m2")])).toEqual([]);
  });

  it("does not map members of unselected groups", () => {
    expect(selectionLinks(units, [edge("outsider", "m1")])).toEqual([]);
  });
});

describe("computeSelectionLayout", () => {
  it("keeps the participating unit bbox center for every mode", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 1000, 500),
      node("c", 2000, 100),
    ];
    const selected = new Set(["a", "b", "c"]);
    const before = centerOf(collectSelectionLayoutUnits(nodes, selected));

    for (const mode of MODES) {
      const { positions } = computeSelectionLayout(nodes, [], selected, mode);
      const after = unitCenter(collectSelectionLayoutUnits(nodes, selected), positions);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it("arranges a horizontal row in reading order", () => {
    const nodes = [node("b", 0, 300), node("a", 800, 0), node("c", 1600, 600)];
    const { positions } = computeSelectionLayout(
      nodes,
      [],
      new Set(["a", "b", "c"]),
      "horizontal",
    );

    expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
    expect(positions.get("b")!.x).toBeLessThan(positions.get("c")!.x);
    for (const id of ["a", "b", "c"]) {
      expect(positions.get(id)!.y).toBe(positions.get("a")!.y);
    }
  });

  it("layers a smart chain left to right", () => {
    const nodes = [node("c", 0, 0), node("a", 400, 0), node("b", 800, 0)];
    const edges = [edge("a", "b"), edge("b", "c")];
    const { positions } = computeSelectionLayout(
      nodes,
      edges,
      new Set(["a", "b", "c"]),
      "smart",
    );

    expect(positions.get("a")!.x).toBeLessThan(positions.get("b")!.x);
    expect(positions.get("b")!.x).toBeLessThan(positions.get("c")!.x);
  });

  it("maps group member edges to group units in smart mode", () => {
    const nodes = [
      group("g1", 0, 0),
      node("m1", 20, 40, 200, 120, { parentId: "g1" }),
      group("g2", 0, 600),
      node("m2", 20, 40, 200, 120, { parentId: "g2" }),
    ];
    const { positions, unitCount } = computeSelectionLayout(
      nodes,
      [edge("m1", "m2")],
      new Set(["g1", "g2"]),
      "smart",
    );

    expect(unitCount).toBe(2);
    expect(positions.get("g1")!.x).toBeLessThan(positions.get("g2")!.x);
  });

  it("degrades smart mode to grid when there are no internal links", () => {
    const nodes = [node("a", 0, 0), node("b", 800, 300), node("c", 1600, 600)];
    const selected = new Set(["a", "b", "c"]);
    const smart = computeSelectionLayout(nodes, [], selected, "smart");
    const grid = computeSelectionLayout(nodes, [], selected, "grid");

    expect([...smart.positions.entries()]).toEqual([...grid.positions.entries()]);
  });

  it("returns movedCount 0 when the selection is already arranged", () => {
    const nodes = [node("a", 0, 0), node("b", 260, 0)];
    const selected = new Set(["a", "b"]);
    const first = computeSelectionLayout(nodes, [], selected, "grid");
    const arranged = applyPositions(nodes, first.positions);
    const second = computeSelectionLayout(arranged, [], selected, "grid");

    expect(second.movedCount).toBe(0);
  });

  it("is idempotent within 1e-6 for all modes", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 500, 300),
      node("c", 1000, 0),
      node("d", 1500, 600),
      node("e", 2000, 200),
    ];
    const edges = [edge("a", "b"), edge("b", "c"), edge("d", "e")];
    const selected = new Set(["a", "b", "c", "d", "e"]);

    for (const mode of MODES) {
      const first = computeSelectionLayout(nodes, edges, selected, mode);
      const arranged = applyPositions(nodes, first.positions);
      const second = computeSelectionLayout(arranged, edges, selected, mode);

      for (const id of selected) {
        const before = first.positions.get(id)!;
        const after = second.positions.get(id)!;
        expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1e-6);
      }
      expect(second.movedCount).toBe(0);
    }
  });

  it("returns an empty result for selections without layout units", () => {
    const nodes = [
      group("g", 0, 0),
      node("m", 20, 40, 200, 120, { parentId: "g" }),
    ];
    expect(
      computeSelectionLayout(nodes, [], new Set(["m"]), "grid"),
    ).toEqual({ positions: new Map(), unitCount: 0, movedCount: 0 });
  });
});
