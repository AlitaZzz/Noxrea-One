/**
 * 参考区排序语义测试：单一数据源 + 派生合并 + 「重连 = 重新入列」。
 *
 * 覆盖：
 * - mergeOrder：偏好存活在前 / 新增按连线序追加 / 失效引用过滤；
 * - bumpRefOrderToTail：手动（重新）连线后对应项置尾（含偏好为空、幂等、
 *   非参考边、非生成面板目标等边界）。
 *
 * 撤销/重做语义（不在本测试范围，由快照机制保证）：undo/redo 整体恢复
 * 快照（含排序偏好），被断开的参考经撤销恢复时回到操作前的精确位置。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { bumpRefOrderToTail, mergeOrder } from "@/features/canvas/shared/ref-order";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode, MediaGenFields, VideoGenSettings } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function imageNode(id: string, src: string): AnyNode {
  return { id, type: NODE_TYPE.IMAGE, position: { x: 0, y: 0 }, data: { src } } as unknown as AnyNode;
}

function audioNode(id: string, src: string): AnyNode {
  return { id, type: NODE_TYPE.AUDIO, position: { x: 0, y: 0 }, data: { src } } as unknown as AnyNode;
}

function genNode(id: string, genSettings?: Partial<VideoGenSettings>): AnyNode {
  return {
    id,
    type: NODE_TYPE.VIDEO,
    position: { x: 0, y: 0 },
    data: { genSettings: genSettings as VideoGenSettings | undefined },
  } as unknown as AnyNode;
}

function edge(source: string, target: string) {
  return { id: `e-${source}-${target}`, source, target };
}

function refOrderOf(nodeId: string): string[] {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  return ((node?.data as MediaGenFields).genSettings as { refOrder?: string[] }).refOrder ?? [];
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
});

describe("mergeOrder 纯函数", () => {
  it("偏好中存活的项在前，未覆盖的新增项按连线序追加在后", () => {
    expect(mergeOrder(["b", "a"], ["a", "c", "b"])).toEqual(["b", "a", "c"]);
  });

  it("偏好中的失效引用（已断开）被自动过滤", () => {
    expect(mergeOrder(["x", "a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("偏好为空时退化为连线序", () => {
    expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("bumpRefOrderToTail：重连 = 重新入列", () => {
  it("偏好已有位置的重连项被移到末尾（✕ 删除第二个后重连排最后）", () => {
    useCanvasStore.setState({
      nodes: [
        imageNode("i1", "a"),
        imageNode("i2", "b"),
        imageNode("i3", "c"),
        genNode("t", { kind: "video", prompt: "", modelKey: "", refOrder: ["a", "b", "c"] }),
      ],
      edges: [edge("i1", "t"), edge("i2", "t"), edge("i3", "t")],
    });

    bumpRefOrderToTail([{ source: "i2", target: "t" }]);

    expect(refOrderOf("t")).toEqual(["a", "c", "b"]);
  });

  it("偏好为空时（从未拖序）：重连项同样排到最后，其余按连线序固化", () => {
    useCanvasStore.setState({
      nodes: [
        imageNode("i1", "a"),
        imageNode("i2", "b"),
        imageNode("i3", "c"),
        genNode("t", { kind: "video", prompt: "", modelKey: "", refOrder: [] }),
      ],
      edges: [edge("i1", "t"), edge("i3", "t")], // b 断开中
    });

    bumpRefOrderToTail([{ source: "i2", target: "t" }]);

    expect(refOrderOf("t")).toEqual(["a", "c", "b"]);
  });

  it("已在末尾时幂等，不产生写入", () => {
    useCanvasStore.setState({
      nodes: [imageNode("i1", "a"), imageNode("i2", "b"), genNode("t", { kind: "video", prompt: "", modelKey: "", refOrder: ["a", "b"] })],
      edges: [edge("i1", "t"), edge("i2", "t")],
    });

    bumpRefOrderToTail([{ source: "i2", target: "t" }]);

    expect(refOrderOf("t")).toEqual(["a", "b"]);
  });

  it("偏好中残留的失效引用被顺带清洗", () => {
    useCanvasStore.setState({
      nodes: [imageNode("i1", "a"), imageNode("i2", "b"), genNode("t", { kind: "video", prompt: "", modelKey: "", refOrder: ["dead", "a", "b"] })],
      edges: [edge("i1", "t"), edge("i2", "t")],
    });

    bumpRefOrderToTail([{ source: "i2", target: "t" }]);

    expect(refOrderOf("t")).toEqual(["a", "b"]);
  });

  it("非参考类边（文本上游）不写入 refOrder", () => {
    const textNode = { id: "txt", type: NODE_TYPE.TEXT, position: { x: 0, y: 0 }, data: { content: "hi" } } as unknown as AnyNode;
    useCanvasStore.setState({
      nodes: [textNode, genNode("t", { kind: "video", prompt: "", modelKey: "", refOrder: [] })],
      edges: [edge("txt", "t")],
    });

    bumpRefOrderToTail([{ source: "txt", target: "t" }]);

    expect(refOrderOf("t")).toEqual([]);
  });

  it("音频参考写入 refAudioOrder 而非 refOrder", () => {
    useCanvasStore.setState({
      nodes: [audioNode("a1", "au.mp3"), genNode("t", { kind: "video", prompt: "", modelKey: "", refOrder: [], refAudioOrder: [] })],
      edges: [edge("a1", "t")],
    });

    bumpRefOrderToTail([{ source: "a1", target: "t" }]);

    const node = useCanvasStore.getState().nodes.find((n) => n.id === "t")!;
    const gs = (node.data as MediaGenFields).genSettings as { refOrder: string[]; refAudioOrder: string[] };
    expect(gs.refAudioOrder).toEqual(["au.mp3"]);
    expect(gs.refOrder).toEqual([]);
  });

  it("目标不是生成面板节点（group 等）时跳过", () => {
    const groupNode = { id: "g", type: NODE_TYPE.GROUP, position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
    useCanvasStore.setState({ nodes: [imageNode("i1", "a"), groupNode], edges: [edge("i1", "g")] });

    expect(() => bumpRefOrderToTail([{ source: "i1", target: "g" }])).not.toThrow();
    expect((groupNode as { data: { genSettings?: unknown } }).data.genSettings).toBeUndefined();
  });

  it("genSettings 不存在时按节点类型创建初始结构再置尾", () => {
    useCanvasStore.setState({
      nodes: [imageNode("i1", "a"), imageNode("i2", "b"), genNode("t")],
      edges: [edge("i1", "t"), edge("i2", "t")],
    });

    bumpRefOrderToTail([{ source: "i2", target: "t" }]);

    const gs = (useCanvasStore.getState().nodes.find((n) => n.id === "t")!.data as MediaGenFields).genSettings as VideoGenSettings | undefined;
    expect(gs?.kind).toBe("video");
    expect(gs?.refOrder).toEqual(["a", "b"]);
  });
});
