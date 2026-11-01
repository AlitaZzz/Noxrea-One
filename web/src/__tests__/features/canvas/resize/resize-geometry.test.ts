import { describe, expect, it } from "vitest";

import { computeResizeSize, type ResizeStart } from "@/features/canvas/resize/resize-geometry";

const start = (overrides: Partial<ResizeStart> = {}): ResizeStart => ({
  pointer: { x: 100, y: 100 },
  width: 200,
  height: 100,
  zoom: 1,
  ...overrides,
});

const MIN = { width: 40, height: 30 };

describe("computeResizeSize", () => {
  it("右下角位移按画布单位加到起始尺寸", () => {
    expect(
      computeResizeSize(start(), { x: 150, y: 160 }, MIN),
    ).toEqual({ width: 250, height: 160 });
  });

  it("指针位移按按下时 zoom 换算（zoom 2 时 40px 对应 20 单位）", () => {
    expect(
      computeResizeSize(start({ zoom: 2 }), { x: 140, y: 120 }, MIN),
    ).toEqual({ width: 220, height: 110 });
  });

  it("收缩到最小尺寸为止", () => {
    expect(
      computeResizeSize(start(), { x: -500, y: -500 }, MIN),
    ).toEqual(MIN);
  });

  it("先四舍五入再应用最小尺寸", () => {
    // 199.6 → 200，200.4 → 200：位移的亚像素误差不进入几何
    expect(computeResizeSize(start({ width: 150 }), { x: 149.6, y: 100 }, MIN))
      .toEqual({ width: 200, height: 100 });
    // 39.6 → 40 恰好等于最小宽度；39.4 → 39 被抬到 40（先取整再夹最小）
    expect(computeResizeSize(start({ width: 40 }), { x: 99.6, y: 100 }, MIN))
      .toEqual({ width: 40, height: 100 });
    expect(computeResizeSize(start({ width: 40 }), { x: 99.4, y: 100 }, MIN))
      .toEqual({ width: 40, height: 100 });
  });

  it("非法 zoom 按 1 处理，不产生 Infinity/NaN", () => {
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        computeResizeSize(start({ zoom }), { x: 120, y: 130 }, MIN),
      ).toEqual({ width: 220, height: 130 });
    }
  });
});
