import { describe, expect, it } from "vitest";

import {
  buildMarqueeGeometryIndex,
  MARQUEE_CELL_SIZE,
  queryMarqueeSelection,
} from "@/features/canvas/marquee/marquee-geometry";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

import { marqueeBox } from "./fixtures";

const group = (id: string, x: number, y: number, width = 200, height = 200): AnyNode =>
  marqueeBox(id, x, y, { width, height, type: NODE_TYPE.GROUP });

const member = (
  id: string,
  parentId: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
): AnyNode => marqueeBox(id, x, y, { width, height, parentId });

const EMPTY = new Set<string>();

function query(
  nodes: AnyNode[],
  x: number,
  y: number,
  width: number,
  height: number,
  baseline: ReadonlySet<string> = EMPTY,
): Set<string> {
  return queryMarqueeSelection(
    buildMarqueeGeometryIndex(nodes),
    { x, y, width, height },
    baseline,
  );
}

const sorted = (ids: Set<string>) => [...ids].sort();

describe("queryMarqueeSelection", () => {
  it("普通节点与矩形相交即命中", () => {
    const nodes = [marqueeBox("a", 0, 0), marqueeBox("b", 400, 0)];

    expect(sorted(query(nodes, 50, 50, 100, 100))).toEqual(["a"]);
    expect(sorted(query(nodes, 350, 50, 100, 100))).toEqual(["b"]);
    expect(sorted(query(nodes, 200, 200, 50, 50))).toEqual([]);
  });

  it("边界恰好相接不算相交", () => {
    const nodes = [marqueeBox("a", 100, 0)];

    expect(sorted(query(nodes, 0, 0, 100, 100))).toEqual([]);
    expect(sorted(query(nodes, 0, 0, 100.5, 100))).toEqual(["a"]);
  });

  it("反向拖出的矩形按归一化坐标命中", () => {
    const nodes = [marqueeBox("a", 40, 40)];

    expect(sorted(query(nodes, 150, 150, -100, -100))).toEqual(["a"]);
  });

  it("组被完全包含才命中，部分相交只命中成员", () => {
    const nodes = [group("g", 0, 0), member("m", "g", 10, 10)];

    // 完全包含组：命中组，成员被组排除
    expect(sorted(query(nodes, -10, -10, 250, 250))).toEqual(["g"]);
    // 部分相交：组不命中，相交成员单独命中
    expect(sorted(query(nodes, 50, 50, 100, 100))).toEqual(["m"]);
    // 部分相交且成员也未相交：两者都不命中
    expect(sorted(query(nodes, 150, 150, 100, 100))).toEqual([]);
  });

  it("已选中组的成员不单独命中", () => {
    const nodes = [group("g", 0, 0), member("m", "g", 10, 10)];

    expect(sorted(query(nodes, 50, 50, 20, 20, new Set(["g"])))).toEqual(["g"]);
  });

  it("追加选择以 baseline 为起点并保留未被组排除的条目", () => {
    const nodes = [
      marqueeBox("a", 0, 0),
      marqueeBox("b", 400, 0),
      group("g", 1000, 0),
      member("m", "g", 10, 10),
    ];

    expect(sorted(query(nodes, 350, 50, 100, 100, new Set(["a"])))).toEqual(["a", "b"]);
    // baseline 含组时，命中的成员被剔除
    expect(sorted(query(nodes, 950, 50, 100, 100, new Set(["g"])))).toEqual(["g"]);
  });

  it("组内成员的绝对坐标叠加父组位移", () => {
    const nodes = [group("g", 100, 100, 300), member("m", "g", 10, 10, 50)];

    expect(sorted(query(nodes, 105, 105, 10, 10))).toEqual(["m"]);
    expect(sorted(query(nodes, 0, 0, 50, 50))).toEqual([]);
  });

  it("hidden 与 selectable=false 的节点不参与命中", () => {
    const nodes = [
      marqueeBox("hidden", 0, 0, { hidden: true }),
      marqueeBox("locked", 300, 0, { selectable: false }),
      marqueeBox("normal", 600, 0),
    ];

    expect(sorted(query(nodes, -1000, -1000, 3000, 3000))).toEqual(["normal"]);
  });

  it("跨单元超过阈值的节点进入大节点列表，小矩形仍能命中", () => {
    const huge = marqueeBox("huge", 0, 0, {
      width: MARQUEE_CELL_SIZE * 16,
      height: MARQUEE_CELL_SIZE * 16,
    });
    const index = buildMarqueeGeometryIndex([huge]);

    expect(index.largeEntries).toHaveLength(1);
    expect(index.cells.size).toBe(0);
    expect(sorted(queryMarqueeSelection(index, { x: 10, y: 10, width: 20, height: 20 }, EMPTY))).toEqual([
      "huge",
    ]);
  });

  it("查询覆盖单元数超过上限时退化为全量扫描", () => {
    const nodes = [
      marqueeBox("far", 50000, 50000, { width: 10, height: 10 }),
      marqueeBox("near", 0, 0),
    ];
    const index = buildMarqueeGeometryIndex(nodes);
    const span = (MARQUEE_CELL_SIZE * 201) ** 2;

    expect(
      sorted(
        queryMarqueeSelection(index, { x: 0, y: 0, width: span, height: span }, EMPTY),
      ),
    ).toEqual(["far", "near"]);
  });
});
