import { describe, expect, it } from "vitest";

import { clampRect } from "./crop-video";

/** yuv420p 不变量：偏移与宽高必须为偶数，且矩形不得越出源画面 */
function assertEvenAndInside(
  rect: { x: number; y: number; width: number; height: number },
  srcW: number,
  srcH: number,
) {
  expect(rect.x % 2).toBe(0);
  expect(rect.y % 2).toBe(0);
  expect(rect.width % 2).toBe(0);
  expect(rect.height % 2).toBe(0);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(srcW);
  expect(rect.y + rect.height).toBeLessThanOrEqual(srcH);
  expect(rect.width).toBeGreaterThanOrEqual(2);
  expect(rect.height).toBeGreaterThanOrEqual(2);
}

describe("clampRect 偶数钳位", () => {
  it("奇数宽源全幅裁剪：宽高与偏移全为偶数且不越界", () => {
    const rect = clampRect({ x: 0, y: 0, width: 853, height: 481 }, 853, 481);
    assertEvenAndInside(rect, 853, 481);
    expect(rect).toEqual({ x: 0, y: 0, width: 852, height: 480 });
  });

  it("奇数偏移被取偶", () => {
    const rect = clampRect({ x: 101, y: 7, width: 200, height: 200 }, 853, 481);
    assertEvenAndInside(rect, 853, 481);
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(6);
  });

  it("右/下越界钳位后偏移仍为偶数（修复点：右项经过 even）", () => {
    // 853-800=53（奇数），旧实现会让 x=53 越过偶数约束
    const rect = clampRect({ x: 100, y: 0, width: 800, height: 400 }, 853, 481);
    assertEvenAndInside(rect, 853, 481);
    expect(rect.x).toBe(52);
  });

  it("极端小源：钳位后至少保留 2x2", () => {
    const rect = clampRect({ x: 0, y: 0, width: 853, height: 481 }, 3, 3);
    assertEvenAndInside(rect, 3, 3);
    expect(rect.width).toBe(2);
    expect(rect.height).toBe(2);
  });
});
