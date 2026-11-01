/**
 * 读序共享实现测试：画布整理与组内布局共用同一份分带排序。
 */

import { describe, expect, it } from "vitest";

import { sortBoxesByReading } from "@/features/canvas/shared/reading-order";

interface Box {
  id: string;
  x: number;
  y: number;
  height: number;
}

function box(id: string, x: number, y: number, height = 120): Box {
  return { id, x, y, height };
}

const ids = (boxes: Box[]) => boxes.map((b) => b.id);

describe("sortBoxesByReading", () => {
  it("空数组与单元素原样返回", () => {
    expect(sortBoxesByReading([])).toEqual([]);
    expect(ids(sortBoxesByReading([box("a", 10, 10)]))).toEqual(["a"]);
  });

  it("按垂直中线分带，带内按 x 升序", () => {
    const boxes = [box("b", 400, 20), box("a", 0, 0), box("d", 0, 900), box("c", 200, 700)];
    expect(ids(sortBoxesByReading(boxes))).toEqual(["a", "b", "c", "d"]);
  });

  it("中线对齐即同一横带：高矮混排不受顶边差影响", () => {
    // tall 中线 150，short 中线 210：平均高 210 → 带高 105，中线差 60 → 同带，
    // 按 x 读序 short 在左。若按顶边分带，顶边差 150 会把两者拆成两带、顺序颠倒。
    const boxes = [box("tall", 400, 0, 300), box("short", 0, 150, 120)];
    expect(ids(sortBoxesByReading(boxes))).toEqual(["short", "tall"]);
  });

  it("带高取平均高度的一半，上下两行不会并成一带", () => {
    // 平均高度 120 → 带高 60；y 相差 60 已跨带
    expect(ids(sortBoxesByReading([box("low", 0, 60), box("high", 500, 0)]))).toEqual([
      "high",
      "low",
    ]);
  });

  it("x 与 y 都相同时保持入参顺序（排序稳定）", () => {
    expect(ids(sortBoxesByReading([box("a", 0, 0), box("b", 0, 0)]))).toEqual(["a", "b"]);
    expect(ids(sortBoxesByReading([box("b", 0, 0), box("a", 0, 0)]))).toEqual(["b", "a"]);
  });
});
