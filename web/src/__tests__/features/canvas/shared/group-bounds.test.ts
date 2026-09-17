/**
 * computeFittedGroupRect 测试：组框随成员变化的自适应几何。
 */

import { describe, expect, it } from "vitest";

import { computeFittedGroupRect } from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_MIN_HEIGHT, GROUP_NODE_MIN_WIDTH, GROUP_NODE_PADDING, NODE_TYPE } from "@/lib/constants";

function node(id: string, x: number, y: number, w: number, h: number, extra?: Record<string, unknown>): AnyNode {
  return {
    id,
    position: { x, y },
    style: { width: w, height: h },
    ...extra,
  } as unknown as AnyNode;
}

function group(id: string, x: number, y: number, w: number, h: number): AnyNode {
  return node(id, x, y, w, h, { type: NODE_TYPE.GROUP });
}

describe("computeFittedGroupRect", () => {
  it("成员都在组框内时返回 null（无需变化）", () => {
    // 组框 = 成员 bbox(100,100 ~ 400,300) 外扩 padding 40
    const g = group("g1", 100 - GROUP_NODE_PADDING, 100 - GROUP_NODE_PADDING, 300 + GROUP_NODE_PADDING * 2, 200 + GROUP_NODE_PADDING * 2);
    const members = [node("a", 100, 100, 300, 200)];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("成员探出右边时组框扩张，位置不动", () => {
    const g = group("g1", 60, 60, 400, 400);
    const members = [node("a", 100, 100, 500, 100)];
    const rect = computeFittedGroupRect(g, members)!;
    expect(rect.x).toBe(60);
    expect(rect.y).toBe(60);
    // 右边界 = 成员右缘(600) + padding(40) = 640 → 宽 580
    expect(rect.width).toBe(500 + GROUP_NODE_PADDING * 2);
  });

  it("成员探出左上时组框原点随之移动", () => {
    const g = group("g1", 100, 100, 400, 400);
    const members = [node("a", 0, 0, 200, 200)];
    const rect = computeFittedGroupRect(g, members)!;
    expect(rect.x).toBe(-GROUP_NODE_PADDING);
    expect(rect.y).toBe(-GROUP_NODE_PADDING);
    // 右边界 = max(500, 200 + 40) = 500 → 宽 540
    expect(rect.width).toBe(500 + GROUP_NODE_PADDING);
  });

  it("手动放大的组框不因成员变小而收缩（只扩不缩）", () => {
    const g = group("g1", 0, 0, 2000, 2000);
    const members = [node("a", 100, 100, 100, 100)];
    expect(computeFittedGroupRect(g, members)).toBeNull();
  });

  it("无成员时收缩到最小尺寸（保持左上角）", () => {
    const g = group("g1", 123, 456, 800, 600);
    const rect = computeFittedGroupRect(g, [])!;
    expect(rect.x).toBe(123);
    expect(rect.y).toBe(456);
    expect(rect.width).toBe(GROUP_NODE_MIN_WIDTH);
    expect(rect.height).toBe(GROUP_NODE_MIN_HEIGHT);
  });

  it("无成员且已是最小尺寸时返回 null", () => {
    const g = group("g1", 123, 456, GROUP_NODE_MIN_WIDTH, GROUP_NODE_MIN_HEIGHT);
    expect(computeFittedGroupRect(g, [])).toBeNull();
  });
});
