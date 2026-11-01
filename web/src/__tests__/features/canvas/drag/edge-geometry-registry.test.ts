import { Position } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  edgeIdsForNodes,
  registerEdgeGeometry,
  unregisterEdgeGeometry,
} from "@/features/canvas/drag/edge-geometry-registry";

const registered = new Set<string>();

function register(edgeId: string, sourceId: string, targetId: string): void {
  registerEdgeGeometry(edgeId, {
    sourceId,
    targetId,
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 0,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });
  registered.add(edgeId);
}

afterEach(() => {
  for (const edgeId of registered) unregisterEdgeGeometry(edgeId);
  registered.clear();
});

describe("edge-geometry-registry 端点索引", () => {
  it("按端点查找相关边，自环只计一次", () => {
    register("e1", "a", "b");
    register("e2", "b", "c");
    register("loop", "c", "c");

    expect(edgeIdsForNodes(["a"])).toEqual(new Set(["e1"]));
    expect(edgeIdsForNodes(["b"])).toEqual(new Set(["e1", "e2"]));
    expect(edgeIdsForNodes(["c"])).toEqual(new Set(["e2", "loop"]));
    expect(edgeIdsForNodes(["a", "c"])).toEqual(new Set(["e1", "e2", "loop"]));
    expect(edgeIdsForNodes(["d"])).toEqual(new Set());
  });

  it("重登记到新端点后，旧端点不再关联该边", () => {
    register("e1", "a", "b");

    register("e1", "a", "d");

    expect(edgeIdsForNodes(["b"])).toEqual(new Set());
    expect(edgeIdsForNodes(["d"])).toEqual(new Set(["e1"]));
  });

  it("注销后从端点索引移除，另一端点也随之清理", () => {
    register("e1", "a", "b");

    unregisterEdgeGeometry("e1");
    registered.delete("e1");

    expect(edgeIdsForNodes(["a"])).toEqual(new Set());
    expect(edgeIdsForNodes(["b"])).toEqual(new Set());
  });
});
