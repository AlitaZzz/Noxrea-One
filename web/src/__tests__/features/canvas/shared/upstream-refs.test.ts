import { describe, expect, it } from "vitest";

import { buildUpstreamRefs, sameUpstreamRefs } from "@/features/canvas/shared/upstream-refs";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function node(id: string, x: number, extra?: Record<string, unknown>): AnyNode {
  return {
    id,
    type: "text-node",
    position: { x, y: 0 },
    data: { label: id },
    style: { width: 100, height: 60 },
    ...extra,
  } as AnyNode;
}

const edges = [
  { id: "e1", source: "img", target: "gen" },
  { id: "e2", source: "txt", target: "gen" },
  { id: "e3", source: "aud", target: "gen" },
] as const;

function upstreamNodes(): AnyNode[] {
  return [
    { ...node("img", 0), type: NODE_TYPE.IMAGE, data: { src: "s1" } } as AnyNode,
    { ...node("txt", 200), type: NODE_TYPE.TEXT, data: { plainText: " hi " } } as AnyNode,
    { ...node("aud", 400), type: NODE_TYPE.AUDIO, data: { src: "a1", label: " voice " } } as AnyNode,
    { ...node("gen", 600), type: NODE_TYPE.IMAGE, data: {} } as AnyNode,
  ];
}

describe("buildUpstreamRefs", () => {
  it("按类型归集入边的上游引用并 trim", () => {
    const refs = buildUpstreamRefs(upstreamNodes(), [...edges], "gen");
    expect(refs.images).toEqual(["s1"]);
    expect(refs.texts).toEqual([{ id: "txt", content: "hi" }]);
    expect(refs.audios).toEqual([{ id: "aud", src: "a1", label: "voice" }]);
    expect(refs.videos).toEqual([]);
  });

  it("图片按节点数组顺序，媒体按 id 与 src 双重去重", () => {
    const nodes: AnyNode[] = [
      { ...node("img1", 0), type: NODE_TYPE.IMAGE, data: { src: "old" } } as AnyNode,
      { ...node("img2", 0), type: NODE_TYPE.IMAGE, data: { src: "new" } } as AnyNode,
      { ...node("aud1", 0), type: NODE_TYPE.AUDIO, data: { src: "same", label: " 首条 " } } as AnyNode,
      { ...node("aud2", 0), type: NODE_TYPE.AUDIO, data: { src: "same", label: "重复" } } as AnyNode,
      { ...node("gen", 0), type: NODE_TYPE.IMAGE, data: {} } as AnyNode,
    ];
    const refs = buildUpstreamRefs(nodes, [
      { id: "e1", source: "img2", target: "gen" },
      { id: "e2", source: "img1", target: "gen" },
      { id: "e3", source: "aud1", target: "gen" },
      { id: "e4", source: "aud2", target: "gen" },
    ], "gen");
    expect(refs.images).toEqual(["old", "new"]);
    expect(refs.audios).toEqual([{ id: "aud1", src: "same", label: "首条" }]);
  });
});

describe("sameUpstreamRefs", () => {
  it("位置帧不改内容：按值相等，订阅可 bail", () => {
    const first = buildUpstreamRefs(upstreamNodes(), [...edges], "gen");
    const moved = upstreamNodes().map((item) => ({
      ...item,
      position: { ...item.position, x: item.position.x + 12 },
    }));
    const second = buildUpstreamRefs(moved, [...edges], "gen");
    expect(second).not.toBe(first);
    expect(sameUpstreamRefs(first, second)).toBe(true);
  });

  it("上游数据变化时按值不等", () => {
    const first = buildUpstreamRefs(upstreamNodes(), [...edges], "gen");
    const edited = upstreamNodes().map((item) =>
      item.id === "txt" ? ({ ...item, data: { plainText: "bye" } } as AnyNode) : item,
    );
    expect(sameUpstreamRefs(first, buildUpstreamRefs(edited, [...edges], "gen"))).toBe(false);
  });
});
