import { describe, expect, it } from "vitest";

import {
  applySnapOffset,
  buildSnapFrame,
  buildSnapTargets,
  type MovingBox,
  nodeAbsoluteBounds,
} from "@/features/canvas/drag/drag-snap";
import { buildNodeIndex } from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

const node = (
  id: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): AnyNode =>
  ({
    id,
    type: NODE_TYPE.TEXT,
    position: { x, y },
    data: {},
    ...extra,
  }) as unknown as AnyNode;

const moving = (x: number, y: number, delta: { x: number; y: number }): MovingBox => ({
  bounds: { x, y, width: 100, height: 100 },
  delta,
});

describe("drag-snap 适配层", () => {
  it("盒尺寸取值链：显式 style > measured > 兜底", () => {
    const boundsOf = (n: AnyNode) => nodeAbsoluteBounds(n, buildNodeIndex([n]));
    expect(
      boundsOf(node("a", 0, 0, { style: { width: 80, height: 40 }, measured: { width: 90, height: 50 } })),
    ).toMatchObject({ width: 80, height: 40 });
    expect(boundsOf(node("a", 0, 0, { measured: { width: 90, height: 50 } }))).toMatchObject({
      width: 90,
      height: 50,
    });
    expect(boundsOf(node("a", 0, 0))).toMatchObject({ width: 200, height: 120 });
  });

  it("成员绝对盒经组原点换算", () => {
    const nodes = [
      node("g", 100, 200, { type: NODE_TYPE.GROUP, style: { width: 300, height: 200 } }),
      node("m", 10, 20, { parentId: "g", style: { width: 80, height: 40 } }),
    ];

    expect(nodeAbsoluteBounds(nodes[1], buildNodeIndex(nodes))).toEqual({
      x: 110,
      y: 220,
      width: 80,
      height: 40,
    });
  });

  it("目标排除移动集与隐藏节点，保留组框并沿用 store 顺序", () => {
    const nodes = [
      node("a", 0, 0),
      node("g", 0, 300, { type: NODE_TYPE.GROUP, style: { width: 300, height: 200 } }),
      node("m", 10, 10, { parentId: "g" }),
      node("h", 400, 0, { hidden: true }),
      node("b", 600, 0),
    ];

    const targets = buildSnapTargets(nodes, new Set(["a", "m"]), buildNodeIndex(nodes));
    expect(targets.map((t) => t.id)).toEqual(["g", "b"]);
    expect(targets.map((t) => t.order)).toEqual([1, 4]);
    expect(targets[0].bounds).toEqual({ x: 0, y: 300, width: 300, height: 200 });
  });

  it("无有效尺寸或坐标的节点不进入目标", () => {
    const nodes = [
      node("a", 0, 0),
      node("bad", Number.NaN, 0),
      node("negative", 0, 0, { style: { width: -1, height: -1 } }),
    ];

    expect(buildSnapTargets(nodes, new Set(["a"]), buildNodeIndex(nodes))).toEqual([]);
  });

  it("拖动成员时同组成员与组框仍是目标（验收 4）", () => {
    const nodes = [
      node("g", 0, 0, { type: NODE_TYPE.GROUP, style: { width: 800, height: 600 } }),
      node("m1", 10, 10, { parentId: "g", style: { width: 100, height: 100 } }),
      node("m2", 210, 10, { parentId: "g", style: { width: 100, height: 100 } }),
    ];

    const targets = buildSnapTargets(nodes, new Set(["m1"]), buildNodeIndex(nodes));
    expect(targets.map((t) => t.id)).toEqual(["g", "m2"]);
    expect(targets[1].bounds).toEqual({ x: 210, y: 10, width: 100, height: 100 });
  });

  it("主体为移动集原始并集，Shift 按并集原点位移取主导轴", () => {
    const boxes = [moving(0, 0, { x: 10, y: 2 }), moving(200, 0, { x: 10, y: 2 })];
    const build = (shift: boolean, bypass = false) =>
      buildSnapFrame({
        moving: boxes,
        targets: [],
        zoom: 1,
        settings: { snapEnabled: true, snapGridSize: 24 },
        modifiers: { bypass, shift },
        state: { x: null, y: null },
      });

    const plain = build(false);
    expect(plain.subject).toEqual({ x: 10, y: 2, width: 300, height: 100 });
    expect(plain.modifiers.lockAxis).toBeNull();
    expect(plain.settings).toEqual({ enabled: true, gridSize: 24 });

    expect(build(true).modifiers.lockAxis).toBe("x");
    expect(build(true, true).modifiers).toEqual({ bypass: true, lockAxis: "x" });

    const vertical = buildSnapFrame({
      moving: [moving(0, 0, { x: 2, y: 10 })],
      targets: [],
      zoom: 1,
      settings: { snapEnabled: true, snapGridSize: 24 },
      modifiers: { bypass: false, shift: true },
      state: { x: null, y: null },
    });
    expect(vertical.modifiers.lockAxis).toBe("y");

    const tie = buildSnapFrame({
      moving: [moving(0, 0, { x: 5, y: 5 })],
      targets: [],
      zoom: 1,
      settings: { snapEnabled: true, snapGridSize: 24 },
      modifiers: { bypass: false, shift: true },
      state: { x: null, y: null },
    });
    expect(tie.modifiers.lockAxis).toBe("x");
  });

  it("吸附偏移应用到全部拖动项；零偏移不复制", () => {
    const raw = new Map([
      ["a", { x: 10, y: 20 }],
      ["b", { x: 30, y: 40 }],
    ]);

    expect(applySnapOffset(raw, { x: 0, y: 0 })).toBe(raw);

    const next = applySnapOffset(raw, { x: 5, y: -2 });
    expect(next.get("a")).toEqual({ x: 15, y: 18 });
    expect(next.get("b")).toEqual({ x: 35, y: 38 });
    expect(raw.get("a")).toEqual({ x: 10, y: 20 });
  });
});
