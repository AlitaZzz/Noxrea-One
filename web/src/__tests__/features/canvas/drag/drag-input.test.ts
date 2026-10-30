import { describe, expect, it } from "vitest";

import { dragInputFromEvent } from "@/features/canvas/drag/drag-input";

describe("拖动开始事件输入", () => {
  it("Ctrl 或 Meta 触发旁路，Shift 触发轴限", () => {
    expect(dragInputFromEvent({ ctrlKey: true, metaKey: false, shiftKey: false })).toEqual({
      modifiers: { bypass: true, shift: false },
      touch: false,
    });
    expect(dragInputFromEvent({ ctrlKey: false, metaKey: true, shiftKey: true })).toEqual({
      modifiers: { bypass: true, shift: true },
      touch: false,
    });
    expect(dragInputFromEvent({ shiftKey: true })).toEqual({
      modifiers: { bypass: false, shift: true },
      touch: false,
    });
  });

  it("非事件值或缺失字段按无修饰键处理", () => {
    for (const event of [null, undefined, "x", 0, {}]) {
      expect(dragInputFromEvent(event)).toEqual({
        modifiers: { bypass: false, shift: false },
        touch: false,
      });
    }
  });

  it("TouchEvent 判定只看 touches 字段", () => {
    expect(dragInputFromEvent({ touches: [] })).toEqual({
      modifiers: { bypass: false, shift: false },
      touch: true,
    });
    expect(dragInputFromEvent({ changedTouches: [] }).touch).toBe(false);
    expect(dragInputFromEvent({}).touch).toBe(false);
    expect(dragInputFromEvent(null).touch).toBe(false);
    expect(dragInputFromEvent("touchstart").touch).toBe(false);
  });
});
