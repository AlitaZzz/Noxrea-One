// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { pointerClientPoint } from "@/features/canvas/drag/pointer-position";

describe("pointerClientPoint", () => {
  it("鼠标事件取 clientX/clientY", () => {
    const event = new MouseEvent("mousemove", { clientX: 12, clientY: 34 });
    expect(pointerClientPoint(event)).toEqual({ x: 12, y: 34 });
  });

  it("触屏事件取第一个触点", () => {
    expect(pointerClientPoint({ touches: [{ clientX: 5, clientY: 6 }] })).toEqual({
      x: 5,
      y: 6,
    });
  });

  it("无坐标来源时返回 null", () => {
    expect(pointerClientPoint(null)).toBeNull();
    expect(pointerClientPoint(undefined)).toBeNull();
    expect(pointerClientPoint({})).toBeNull();
    expect(pointerClientPoint({ touches: [] })).toBeNull();
  });
});
