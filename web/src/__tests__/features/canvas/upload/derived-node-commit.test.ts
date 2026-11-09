/**
 * commitDerivedNodes 的注入端口契约：节点与源连线分别经 addNodes / addEdges 写入。
 * 撤销语义（同一 withHistoryBatch 只产生一条记录）见 derived-node-history.test.ts。
 */
import { describe, expect, it, vi } from "vitest";

import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { type CanvasStoreApi, commitDerivedNodes } from "@/features/canvas/upload";

function node(id: string): AnyNode {
  return {
    id,
    type: "image-node",
    position: { x: 0, y: 0 },
    data: {},
  } as AnyNode;
}

describe("commitDerivedNodes", () => {
  it("writes every node and its source edges through the injected store", () => {
    const nodes = [node("a"), node("b")];
    const addNodes = vi.fn();
    const addEdges = vi.fn();
    const store: CanvasStoreApi = {
      nodes: [node("source")],
      addNodes,
      addEdges,
    };

    commitDerivedNodes("source", nodes, store);

    expect(addNodes).toHaveBeenCalledWith(nodes);
    expect(addEdges).toHaveBeenCalledTimes(1);
    const edges = addEdges.mock.calls[0]![0] as AnyEdge[];
    expect(edges).toEqual([
      expect.objectContaining({ source: "source", target: "a" }),
      expect.objectContaining({ source: "source", target: "b" }),
    ]);
  });
});
