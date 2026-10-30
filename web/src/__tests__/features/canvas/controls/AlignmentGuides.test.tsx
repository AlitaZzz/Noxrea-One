// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AlignmentGuides from "@/features/canvas/controls/AlignmentGuides";
import {
  clearPreviewGuides,
  setPreviewGuides,
} from "@/features/canvas/drag/preview-guides";

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    flowToScreenPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  }),
}));

beforeEach(() => clearPreviewGuides());

afterEach(() => {
  cleanup();
  clearPreviewGuides();
  vi.restoreAllMocks();
});

describe("AlignmentGuides", () => {
  it("同坐标但跨度不相交的辅助线按完整几何生成唯一 key", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AlignmentGuides />);

    act(() => {
      setPreviewGuides([
        { type: "vertical", position: 200, start: 0, end: 100 },
        { type: "vertical", position: 200, start: 300, end: 400 },
        { type: "horizontal", position: 200, start: 0, end: 100 },
        { type: "horizontal", position: 200, start: 300, end: 400 },
      ]);
    });

    expect(document.querySelectorAll("line")).toHaveLength(4);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });
});
