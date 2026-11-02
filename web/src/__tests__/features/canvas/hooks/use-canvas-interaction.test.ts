/**
 * 画布根光标门控属性回归：
 * `data-connecting` 只在拖线期间存在；选中态切换（idle ↔ box-selecting）
 * 不得改变它，否则全后代光标规则会让整棵画布子树重算样式。
 */
import { describe, expect, it } from "vitest";

import { canvasRootInteractionAttrs } from "@/features/canvas/hooks/use-canvas-interaction";

describe("canvasRootInteractionAttrs", () => {
  it("拖线期间写 data-connecting", () => {
    expect(canvasRootInteractionAttrs("connecting")).toEqual({
      "data-interaction": "connecting",
      "data-connecting": "true",
    });
  });

  it("其余交互状态不写 data-connecting", () => {
    for (const mode of ["idle", "box-selecting", "dragging-nodes"] as const) {
      expect(canvasRootInteractionAttrs(mode)).toEqual({
        "data-interaction": mode,
        "data-connecting": undefined,
      });
    }
  });
});
