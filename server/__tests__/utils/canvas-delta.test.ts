import { describe, expect, it } from "vitest";

import type { CanvasDelta } from "@server/schemas/canvas";
import { applyCanvasDelta } from "@server/utils/canvas-delta";

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });
const edge = (id: string, source: string, target: string) => ({ id, source, target });

function delta(overrides: Partial<CanvasDelta> = {}): CanvasDelta {
  return {
    nodes: { upsert: [], delete: [] },
    edges: { upsert: [], delete: [] },
    ...overrides,
  };
}

describe("applyCanvasDelta 合并语义", () => {
  it("命中 id 的 upsert 替换基础节点，其余节点保持原样", () => {
    const base = { nodes: [node("a", { data: { v: 1 } }), node("b")] };
    const next = applyCanvasDelta(base, delta({
      nodes: { upsert: [node("a", { data: { v: 2 } })], delete: [] },
    }));

    expect(next.nodes).toEqual([node("a", { data: { v: 2 } }), node("b")]);
  });

  it("基础集合中不存在的 upsert 节点追加到末尾", () => {
    const next = applyCanvasDelta({ nodes: [node("a")] }, delta({
      nodes: { upsert: [node("c")], delete: [] },
    }));

    expect(next.nodes).toEqual([node("a"), node("c")]);
  });

  it("同一 id 同时 delete 与 upsert 时删除优先", () => {
    const next = applyCanvasDelta({ nodes: [node("a"), node("b")] }, delta({
      nodes: { upsert: [node("a", { data: { v: 9 } })], delete: ["a"] },
    }));

    expect(next.nodes).toEqual([node("b")]);
  });

  it("删除优先于基础替换，但仍会追加基础集合外的同 id upsert", () => {
    const next = applyCanvasDelta({ nodes: [node("a")] }, delta({
      nodes: { upsert: [node("b"), node("b", { duplicate: true })], delete: ["b"] },
    }));

    // b 不在基础集合 → 两条 upsert 各追加一次（不额外去重）
    expect(next.nodes).toEqual([node("a"), node("b"), node("b", { duplicate: true })]);
  });

  it("upsert 中重复的新 id 各追加一次", () => {
    const next = applyCanvasDelta({ nodes: [] }, delta({
      nodes: { upsert: [node("c"), node("c")], delete: [] },
    }));

    expect(next.nodes).toEqual([node("c"), node("c")]);
  });

  it("边按同一语义合并：替换、删除优先、追加新 id", () => {
    const next = applyCanvasDelta({
      nodes: [],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    }, delta({
      edges: { upsert: [edge("e1", "a", "c"), edge("e3", "c", "d")], delete: ["e2"] },
    }));

    expect(next.edges).toEqual([edge("e1", "a", "c"), edge("e3", "c", "d")]);
  });

  it("layout 字段只在 delta 中显式出现时覆盖（null 是有效值）", () => {
    const base = {
      nodes: [],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 1 },
      minimapVisible: true,
      snapEnabled: true,
      agentModel: "model-a",
    };

    const untouched = applyCanvasDelta(base, delta());
    expect(untouched).toMatchObject({
      viewport: base.viewport,
      minimapVisible: true,
      snapEnabled: true,
      agentModel: "model-a",
    });

    const overridden = applyCanvasDelta(base, delta({
      viewport: { x: 9, y: 9, zoom: 2 },
      minimapVisible: false,
      snapEnabled: false,
      agentModel: null,
    }));
    expect(overridden).toMatchObject({
      viewport: { x: 9, y: 9, zoom: 2 },
      minimapVisible: false,
      snapEnabled: false,
      agentModel: null,
    });
  });

  it("其余顶层字段从 base 原样保留，不重建未知字段", () => {
    const next = applyCanvasDelta(
      { nodes: [], edges: [], customField: { nested: true }, name: "x" },
      delta(),
    );

    expect(next.customField).toEqual({ nested: true });
    expect(next.name).toBe("x");
  });

  it("base 缺少 nodes/edges 或类型非数组时按空集合处理", () => {
    expect(applyCanvasDelta({}, delta()).nodes).toEqual([]);
    expect(applyCanvasDelta({ nodes: "bad" }, delta()).nodes).toEqual([]);
    expect(applyCanvasDelta({ edges: 1 }, delta()).edges).toEqual([]);
  });
});
