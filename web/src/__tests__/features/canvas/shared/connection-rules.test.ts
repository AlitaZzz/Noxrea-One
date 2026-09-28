import { describe, expect, it } from "vitest";

import {
  buildConnectionPairs,
  buildFanInPairs,
  buildFanoutPairs,
  type ConnectionRuleState,
  connectionWouldCreate,
  pairsWouldCreate,
} from "@/features/canvas/shared/connection-rules";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** 构造仅含连接判定所需字段的最小节点 */
function makeNode(
  id: string,
  type: string = NODE_TYPE.TEXT,
  selected = false,
  data: Record<string, unknown> = {}
): AnyNode {
  return { id, type, selected, position: { x: 0, y: 0 }, data } as unknown as AnyNode;
}

function makeState(
  nodes: AnyNode[],
  edges: { source: string; target: string }[] = []
): ConnectionRuleState {
  return { nodes, edges };
}

describe("buildConnectionPairs", () => {
  it("单个合法对：返回 src → tgt", () => {
    const nodes = [makeNode("a"), makeNode("c")];
    expect(buildConnectionPairs("a", "c", nodes)).toEqual([{ source: "a", target: "c" }]);
  });

  it("类型不可连或自连：无候选对", () => {
    const nodes = [makeNode("a", NODE_TYPE.AUDIO), makeNode("img", NODE_TYPE.IMAGE), makeNode("b")];
    expect(buildConnectionPairs("a", "img", nodes)).toEqual([]); // audio 不输出到 image
    expect(buildConnectionPairs("a", "a", nodes)).toEqual([]);
  });

  it("多选扇出全部类型可连：返回全部选中节点 → 对端（组节点不参与扇出）", () => {
    const nodes = [
      makeNode("a", NODE_TYPE.TEXT, true),
      makeNode("b", NODE_TYPE.TEXT, true),
      makeNode("group", NODE_TYPE.GROUP, true), // 组节点不参与扇出
      makeNode("c", NODE_TYPE.IMAGE),
    ];
    expect(buildConnectionPairs("a", "c", nodes)).toEqual([
      { source: "a", target: "c" },
      { source: "b", target: "c" },
    ]);
  });

  it("多选扇出全有或全无：任一选中节点类型不可连 → 整体拒绝（无候选对）", () => {
    const nodes = [
      makeNode("a", NODE_TYPE.TEXT, true),
      makeNode("audio", NODE_TYPE.AUDIO, true), // audio 不输出到 image
      makeNode("img", NODE_TYPE.IMAGE),
    ];
    expect(buildConnectionPairs("a", "img", nodes)).toEqual([]);
  });

  it("多选扇出：tgt 在多选集合中 → 对端 → 全部选中节点", () => {
    const nodes = [
      makeNode("x", NODE_TYPE.TEXT),
      makeNode("a", NODE_TYPE.IMAGE, true),
      makeNode("b", NODE_TYPE.VIDEO, true),
    ];
    expect(buildConnectionPairs("x", "a", nodes)).toEqual([
      { source: "x", target: "a" },
      { source: "x", target: "b" },
    ]);
  });

  it("多选扇出（反向）全有或全无：任一选中节点类型不可连 → 整体拒绝", () => {
    const nodes = [
      makeNode("x", NODE_TYPE.AUDIO),
      makeNode("a", NODE_TYPE.IMAGE, true), // audio 不输出到 image
      makeNode("b", NODE_TYPE.VIDEO, true),
    ];
    expect(buildConnectionPairs("x", "a", nodes)).toEqual([]);
  });

  it("两端都在多选集合中：退化为单对（拖回选区的取消语义由调用方处理）", () => {
    const nodes = [makeNode("a", NODE_TYPE.TEXT, true), makeNode("b", NODE_TYPE.TEXT, true)];
    expect(buildConnectionPairs("a", "b", nodes)).toEqual([{ source: "a", target: "b" }]);
  });
});

describe("buildFanoutPairs", () => {
  it("全部参与节点类型可连：返回参与集 → target 全部对", () => {
    const participants = [makeNode("a", NODE_TYPE.TEXT), makeNode("b", NODE_TYPE.IMAGE)];
    expect(buildFanoutPairs(participants, makeNode("c", NODE_TYPE.TEXT))).toEqual([
      { source: "a", target: "c" },
      { source: "b", target: "c" },
    ]);
  });

  it("全有或全无：任一参与节点类型不可连 → 整体拒绝（无对）", () => {
    // 复现批量 Handle 场景：文本 + 音频连图片，文本可连但音频不可
    const participants = [makeNode("a", NODE_TYPE.TEXT), makeNode("audio", NODE_TYPE.AUDIO)];
    expect(buildFanoutPairs(participants, makeNode("img", NODE_TYPE.IMAGE))).toEqual([]);
  });

  it("target 在参与集内（拖回选区/自己组成员）：无对", () => {
    const participants = [makeNode("a"), makeNode("b", NODE_TYPE.IMAGE)];
    expect(buildFanoutPairs(participants, makeNode("b", NODE_TYPE.IMAGE))).toEqual([]);
  });

  it("空参与集：无对", () => {
    expect(buildFanoutPairs([], makeNode("c"))).toEqual([]);
  });
});

describe("buildFanInPairs", () => {
  it("全部参与节点类型可连：返回 source → 参与集全部对", () => {
    const participants = [makeNode("a", NODE_TYPE.TEXT), makeNode("b", NODE_TYPE.IMAGE)];
    expect(buildFanInPairs(makeNode("s", NODE_TYPE.TEXT), participants)).toEqual([
      { source: "s", target: "a" },
      { source: "s", target: "b" },
    ]);
  });

  it("全有或全无：任一参与节点类型不可连 → 整体拒绝（无对）", () => {
    // 扇入镜像场景：图片源喂「文本 + 音频」，图片可入文本但不可入音频
    const participants = [makeNode("a", NODE_TYPE.TEXT), makeNode("audio", NODE_TYPE.AUDIO)];
    expect(buildFanInPairs(makeNode("img", NODE_TYPE.IMAGE), participants)).toEqual([]);
  });

  it("source 在参与集内（拖回自己组成员）：无对", () => {
    const participants = [makeNode("a"), makeNode("b", NODE_TYPE.IMAGE)];
    expect(buildFanInPairs(makeNode("b", NODE_TYPE.IMAGE), participants)).toEqual([]);
  });

  it("空参与集：无对", () => {
    expect(buildFanInPairs(makeNode("s"), [])).toEqual([]);
  });
});

describe("pairsWouldCreate", () => {
  it("有新对：true；全部已连：false", () => {
    const pairs = [
      { source: "a", target: "c" },
      { source: "b", target: "c" },
    ];
    expect(pairsWouldCreate(pairs, [{ source: "a", target: "c" }])).toBe(true);
    expect(
      pairsWouldCreate(pairs, [
        { source: "a", target: "c" },
        { source: "b", target: "c" },
      ])
    ).toBe(false);
  });

  it("空对集（整体拒绝/取消）：false", () => {
    expect(pairsWouldCreate([], [])).toBe(false);
  });
});

describe("connectionWouldCreate", () => {
  it("全新对：会产生新边", () => {
    const state = makeState([makeNode("a"), makeNode("c")]);
    expect(connectionWouldCreate("a", "c", state)).toBe(true);
  });

  it("已存在同向连线：不会再产生新边", () => {
    const state = makeState([makeNode("a"), makeNode("c")], [{ source: "a", target: "c" }]);
    expect(connectionWouldCreate("a", "c", state)).toBe(false);
  });

  it("多选扇出部分已连（A→C 已存在、B→C 新）：整体仍可连", () => {
    const state = makeState(
      [makeNode("a", NODE_TYPE.TEXT, true), makeNode("b", NODE_TYPE.TEXT, true), makeNode("c")],
      [{ source: "a", target: "c" }]
    );
    expect(connectionWouldCreate("a", "c", state)).toBe(true);
  });

  it("多选扇出全部已连：不会再产生新边", () => {
    const state = makeState(
      [makeNode("a", NODE_TYPE.TEXT, true), makeNode("b", NODE_TYPE.TEXT, true), makeNode("c")],
      [
        { source: "a", target: "c" },
        { source: "b", target: "c" },
      ]
    );
    expect(connectionWouldCreate("a", "c", state)).toBe(false);
  });

  it("多选扇出含类型不可连的选中节点：整体拒绝，不会产生新边", () => {
    // 复现用户报告：选中文本 + 音频连图片——文本→图片可连但音频不可，
    // 整体拒绝（与创建菜单「全部参与节点兼容才启用」同口径）
    const state = makeState([
      makeNode("a", NODE_TYPE.TEXT, true),
      makeNode("audio", NODE_TYPE.AUDIO, true),
      makeNode("img", NODE_TYPE.IMAGE),
    ]);
    expect(connectionWouldCreate("a", "img", state)).toBe(false);
  });

  it("类型不可连 / 自连：不会产生新边", () => {
    const state = makeState([makeNode("a", NODE_TYPE.AUDIO), makeNode("img", NODE_TYPE.IMAGE)]);
    expect(connectionWouldCreate("a", "img", state)).toBe(false);
    const self = makeState([makeNode("a")]);
    expect(connectionWouldCreate("a", "a", self)).toBe(false);
  });
});
