import { applyNodeChanges } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import { selectCanvasStateChanges } from "@/features/canvas/shared/node-changes";
import type { AnyNode } from "@/features/canvas/types";

describe("selectCanvasStateChanges", () => {
  it("保留交互与尺寸测量变更，忽略 React Flow 结构同步", () => {
    const node = { id: "n1", position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
    const changes = [
      { type: "add", item: node, index: 0 },
      { type: "replace", id: "n1", item: node },
      { type: "remove", id: "n1" },
      { type: "dimensions", id: "n1", dimensions: { width: 100, height: 80 } },
      { type: "select", id: "n1", selected: true },
      { type: "position", id: "n1", position: { x: 20, y: 30 }, dragging: true },
    ] as never[];

    expect(selectCanvasStateChanges(changes)).toEqual([
      { type: "dimensions", id: "n1", dimensions: { width: 100, height: 80 } },
      { type: "select", id: "n1", selected: true },
      { type: "position", id: "n1", position: { x: 20, y: 30 }, dragging: true },
    ]);
  });

  it("应用尺寸变更后保留 React Flow 拖动所需的 measured 尺寸", () => {
    const node = { id: "n1", position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
    const changes = selectCanvasStateChanges([
      { type: "dimensions", id: "n1", dimensions: { width: 100, height: 80 } },
    ]);

    expect(applyNodeChanges(changes, [node])[0]).toMatchObject({
      id: "n1",
      measured: { width: 100, height: 80 },
    });
  });
});
