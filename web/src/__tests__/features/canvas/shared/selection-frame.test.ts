/**
 * computeSelectionFrame / frameRailWidth 测试：框选外框几何与成员轨道钳制。
 * 钳制规则与组框同源（容器边缘即成员条带外界），回归点是「最贴框缘成员的
 * 条带不得越过框缘盖住外框批量轨道命中区」。
 */

import { describe, expect, it } from "vitest";

import {
  computeSelectionFrame,
  frameRailWidth,
} from "@/features/canvas/shared/selection-frame";
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, NODE_TYPE, RAIL_WIDTH } from "@/lib/constants";

function node(id: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): AnyNode {
  return {
    id,
    position: { x, y },
    style: { width: w, height: h },
    ...extra,
  } as unknown as AnyNode;
}

describe("computeSelectionFrame", () => {
  it("未选中 / 单个选中节点不产生外框", () => {
    const a = node("a", 0, 0, 200, 100);
    const b = node("b", 400, 0, 200, 100);
    expect(computeSelectionFrame([a, b])).toBeNull();
    expect(computeSelectionFrame([a, { ...b, selected: true }])).toBeNull();
  });

  it("组节点不参与外框（全是组的选中不产生外框）", () => {
    const g = node("g", 0, 0, 400, 300, { type: NODE_TYPE.GROUP, selected: true });
    expect(computeSelectionFrame([g])).toBeNull();
  });

  it("≥2 非组选中节点产生 bbox 外框，未选中节点不计入", () => {
    const a = node("a", 0, 0, 200, 100, { selected: true });
    const b = node("b", 400, 100, 200, 100, { selected: true });
    const outside = node("c", 1000, 1000, 200, 100);
    const frame = computeSelectionFrame([a, b, outside])!;
    expect(frame.ids).toEqual(["a", "b"]);
    expect(frame.bbox).toEqual({ x: 0, y: 0, width: 600, height: 200 });
  });
});

describe("frameRailWidth（成员轨道不伸出框选外框）", () => {
  const a = node("a", 0, 0, 200, 100, { selected: true });
  const b = node("b", 400, 0, 200, 100, { selected: true });

  it("无外框（未选中 / 单选）时不夹取", () => {
    expect(frameRailWidth([a, b], "a", "right")).toBe(RAIL_WIDTH);
  });

  it("最右成员右轨净距恒为 GROUP_NODE_PADDING（框缘外扩量）", () => {
    expect(frameRailWidth([a, b], "b", "right")).toBe(GROUP_NODE_PADDING);
  });

  it("最左成员左轨同理", () => {
    expect(frameRailWidth([a, b], "a", "left")).toBe(GROUP_NODE_PADDING);
  });

  it("离框缘远的成员按净距夹取（净距 < RAIL_WIDTH 时）", () => {
    // bbox 右缘 600 + 40 = 640，a 右缘 200 → 净距 440 > RAIL_WIDTH 不夹
    expect(frameRailWidth([a, b], "a", "right")).toBe(RAIL_WIDTH);
    // bbox 左缘 0 − 40 = −40，b 左缘 400 → 净距 440 不夹
    expect(frameRailWidth([a, b], "b", "left")).toBe(RAIL_WIDTH);
  });

  it("非最右成员按到框缘的净距夹取（净距 < RAIL_WIDTH 时）", () => {
    // bbox 右缘 600（b），框缘 640：a 右缘 580 → 净距 60 夹取
    const near = [node("a", 380, 0, 200, 100, { selected: true }), b];
    expect(frameRailWidth(near, "a", "right")).toBe(60);
    // a 右缘 500 → 净距 140 > RAIL_WIDTH 不夹
    const far = [node("a", 300, 0, 200, 100, { selected: true }), b];
    expect(frameRailWidth(far, "a", "right")).toBe(RAIL_WIDTH);
  });

  it("未选中节点不受钳制（不是外框成员）", () => {
    const c = node("c", 500, 0, 200, 100); // 右缘 700，超出 bbox 右缘 640
    expect(frameRailWidth([a, b, c], "c", "right")).toBe(RAIL_WIDTH);
  });

  it("组内成员被框选时同样按框缘夹取（与 memberRailWidth 由调用方取 min 叠加）", () => {
    const innerA = node("ia", 0, 0, 200, 100, { selected: true });
    const innerB = node("ib", 400, 0, 200, 100, { selected: true });
    expect(frameRailWidth([innerA, innerB], "ib", "right")).toBe(GROUP_NODE_PADDING);
    expect(frameRailWidth([innerA, innerB], "ia", "right")).toBe(RAIL_WIDTH);
  });
});
