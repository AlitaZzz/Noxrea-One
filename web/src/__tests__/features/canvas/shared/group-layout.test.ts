/**
 * 组内布局算法测试（纯函数）。
 *
 * 覆盖：宫格读序 / 行内居中 / 组框尺寸、水平与垂直的跨轴居中、
 * 智能布局的分层 / 菱形 / 成环与孤立兜底 / 无组内边退化宫格、
 * 组外边与自环忽略、结果归一化到布局原点。
 */

import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import {
  arrangeGroup,
  type GroupLayoutResult,
} from "@/features/canvas/shared/group-layout";
import type { AnyNode } from "@/features/canvas/types";
import {
  GROUP_LAYOUT_COLUMN_GAP,
  GROUP_LAYOUT_GAP,
  GROUP_NODE_MIN_HEIGHT,
  GROUP_NODE_MIN_WIDTH,
  GROUP_NODE_PADDING,
  NODE_TITLE_HEIGHT,
  NODE_TYPE,
} from "@/lib/constants";

/** 布局原点：padding + 标题栏 */
const ORIGIN = { x: GROUP_NODE_PADDING, y: NODE_TITLE_HEIGHT + GROUP_NODE_PADDING };

// ── 构造辅助 ──────────────────────────────────────────────

function member(id: string, x: number, y: number, w = 200, h = 120): AnyNode {
  return {
    id,
    type: NODE_TYPE.IMAGE,
    position: { x, y },
    style: { width: w, height: h },
    data: { label: id },
    parentId: "g",
  } as unknown as AnyNode;
}

function link(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

function xy(result: GroupLayoutResult, id: string) {
  const p = result.positions.get(id);
  if (!p) throw new Error(`缺少成员坐标：${id}`);
  return p;
}

// ── 宫格 ──────────────────────────────────────────────────

describe("arrangeGroup 宫格", () => {
  it("按读序（自上而下、同行自左而右）填充，而非 store 数组顺序", () => {
    // 入参数组顺序打乱，坐标才代表视觉读序
    const members = [
      member("a", 500, 300),
      member("b", 100, 50),
      member("c", 900, 700),
      member("d", 200, 800),
    ];
    const r = arrangeGroup(members, [], "grid");

    // 2 列（ceil(√4)）：第一行 b、a，第二行 c、d
    expect(xy(r, "b")).toEqual({ x: ORIGIN.x, y: ORIGIN.y });
    expect(xy(r, "a")).toEqual({ x: ORIGIN.x + 200 + GROUP_LAYOUT_GAP, y: ORIGIN.y });
    expect(xy(r, "c")).toEqual({ x: ORIGIN.x, y: ORIGIN.y + 120 + GROUP_LAYOUT_GAP });
    expect(xy(r, "d")).toEqual({
      x: ORIGIN.x + 200 + GROUP_LAYOUT_GAP,
      y: ORIGIN.y + 120 + GROUP_LAYOUT_GAP,
    });
  });

  it("行内垂直居中：高矮混排时矮成员相对行顶下移", () => {
    const members = [member("tall", 0, 0, 200, 300), member("short", 400, 0, 200, 120)];
    const r = arrangeGroup(members, [], "grid");

    expect(xy(r, "tall").y).toBe(ORIGIN.y);
    expect(xy(r, "short").y).toBe(ORIGIN.y + (300 - 120) / 2);
  });

  it("列宽紧凑：后一列紧跟当前成员宽度累加，不按统一最大格留空槽", () => {
    const members = [
      member("a", 0, 0, 100, 120),
      member("b", 0, 0, 300, 120),
      member("c", 0, 200, 200, 120),
      member("d", 0, 200, 300, 120),
    ];
    const r = arrangeGroup(members, [], "grid");

    // 2 列：第一行 a、b，第二行 c、d；b 紧接 a 的 100 宽之后，而非被撑到 300
    expect(xy(r, "b").x).toBe(ORIGIN.x + 100 + GROUP_LAYOUT_GAP);
    expect(xy(r, "d").x).toBe(ORIGIN.x + 200 + GROUP_LAYOUT_GAP);
  });

  it("组框尺寸按内容包围盒推导（与 GroupNode 最小尺寸公式一致）", () => {
    const members = [member("tall", 0, 0, 200, 300), member("short", 400, 0, 200, 120)];
    const r = arrangeGroup(members, [], "grid");

    expect(r.width).toBe(200 + GROUP_LAYOUT_GAP + 200 + GROUP_NODE_PADDING * 2);
    expect(r.height).toBe(
      300 + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2,
    );
  });

  it("单成员归位到布局原点，组框按内容包围盒推导", () => {
    const r = arrangeGroup([member("only", 800, 500)], [], "grid");

    expect(xy(r, "only")).toEqual(ORIGIN);
    expect(r.width).toBe(200 + GROUP_NODE_PADDING * 2);
    expect(r.height).toBe(120 + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
  });

  it("内容小于最小组框时按下限取值", () => {
    const r = arrangeGroup([member("tiny", 0, 0, 100, 10)], [], "grid");

    expect(r.width).toBe(GROUP_NODE_MIN_WIDTH);
    expect(r.height).toBe(GROUP_NODE_MIN_HEIGHT);
  });

  it("空成员返回最小组框、无坐标", () => {
    const r = arrangeGroup([], [], "grid");
    expect(r.positions.size).toBe(0);
    expect(r.width).toBe(GROUP_NODE_MIN_WIDTH);
    expect(r.height).toBe(GROUP_NODE_MIN_HEIGHT);
  });
});

// ── 水平 / 垂直 ───────────────────────────────────────────

describe("arrangeGroup 水平与垂直", () => {
  it("水平：按读序单行排列，矮成员相对最高成员垂直居中", () => {
    const members = [member("a", 0, 0, 200, 120), member("b", 400, 0, 200, 300)];
    const r = arrangeGroup(members, [], "horizontal");

    expect(xy(r, "a")).toEqual({ x: ORIGIN.x, y: ORIGIN.y + (300 - 120) / 2 });
    expect(xy(r, "b")).toEqual({ x: ORIGIN.x + 200 + GROUP_LAYOUT_GAP, y: ORIGIN.y });
  });

  it("垂直：按读序单列排列，窄成员相对最宽成员水平居中", () => {
    const members = [member("a", 0, 0, 200, 120), member("b", 0, 400, 300, 120)];
    const r = arrangeGroup(members, [], "vertical");

    expect(xy(r, "a")).toEqual({ x: ORIGIN.x + (300 - 200) / 2, y: ORIGIN.y });
    expect(xy(r, "b")).toEqual({
      x: ORIGIN.x,
      y: ORIGIN.y + 120 + GROUP_LAYOUT_GAP,
    });
  });
});

// ── 智能布局 ──────────────────────────────────────────────

describe("arrangeGroup 智能", () => {
  it("链式连线：上游在左，列间距 = 列宽 + 列间距，同链水平对齐", () => {
    const members = [member("a", 0, 0), member("b", 0, 0), member("c", 0, 0)];
    const r = arrangeGroup(members, [link("a", "b"), link("b", "c")], "smart");
    const step = 200 + GROUP_LAYOUT_COLUMN_GAP;

    expect(xy(r, "a")).toEqual(ORIGIN); // 归一化后首个上游落在布局原点
    expect(xy(r, "b").x - xy(r, "a").x).toBe(step);
    expect(xy(r, "c").x - xy(r, "b").x).toBe(step);
    expect(xy(r, "a").y).toBe(xy(r, "c").y);
  });

  it("菱形：同层兄弟垂直排成一列，下游在两者右侧", () => {
    const members = [
      member("a", 0, 0),
      member("b", 0, 200),
      member("c", 0, 400),
      member("d", 0, 600),
    ];
    const r = arrangeGroup(
      members,
      [link("a", "b"), link("a", "c"), link("b", "d"), link("c", "d")],
      "smart",
    );

    expect(xy(r, "a").x).toBeLessThan(xy(r, "b").x);
    expect(xy(r, "b").x).toBe(xy(r, "c").x);
    expect(xy(r, "d").x).toBeGreaterThan(xy(r, "b").x);
    expect(Math.abs(xy(r, "c").y - xy(r, "b").y)).toBe(120 + GROUP_LAYOUT_GAP);
  });

  it("成环成员不能喂给 dagre：整环单列排在主图位置", () => {
    const members = [member("a", 0, 0), member("b", 0, 0)];
    const r = arrangeGroup(members, [link("a", "b"), link("b", "a")], "smart");

    expect(xy(r, "a").x).toBe(xy(r, "b").x);
    expect(xy(r, "b").y - xy(r, "a").y).toBe(120 + GROUP_LAYOUT_GAP);
  });

  it("环内成员与孤立成员同列：环不参与主图，整列排到主图右侧", () => {
    const members = [
      member("a", 0, 0),
      member("b", 0, 0),
      member("c", 0, 0),
      member("d", 0, 0),
    ];
    const r = arrangeGroup(
      members,
      [link("a", "b"), link("c", "d"), link("d", "c")],
      "smart",
    );

    // 主链 a → b 不变；环内 c、d 同列排在 b 右侧，按读序上下相邻
    expect(xy(r, "b").x - xy(r, "a").x).toBe(200 + GROUP_LAYOUT_COLUMN_GAP);
    expect(xy(r, "c").x).toBeGreaterThan(xy(r, "b").x);
    expect(xy(r, "c").x).toBe(xy(r, "d").x);
    expect(Math.abs(xy(r, "d").y - xy(r, "c").y)).toBe(120 + GROUP_LAYOUT_GAP);
  });

  it("孤立成员单列排到主图右侧，不打断主链路", () => {
    const members = [member("a", 0, 0), member("b", 0, 0), member("c", 0, 0)];
    const r = arrangeGroup(members, [link("a", "b")], "smart");
    const step = 200 + GROUP_LAYOUT_COLUMN_GAP;

    expect(xy(r, "b").x - xy(r, "a").x).toBe(step);
    expect(xy(r, "c").x - xy(r, "a").x).toBe(step * 2);
    expect(xy(r, "c").y).toBe(xy(r, "a").y);
  });

  it("尾列相对主图垂直居中：主图更高时孤立成员下移一半高差", () => {
    // 主图 a → (b, c) 高 = 120 + 间距 + 120；孤立成员高 120
    const members = [
      member("a", 0, 0),
      member("b", 0, 200),
      member("c", 0, 400),
      member("solo", 0, 600),
    ];
    const r = arrangeGroup(members, [link("a", "b"), link("a", "c")], "smart");

    // 主图高 = 120 + 间距 + 120，孤立成员高 120 → 下移高差的一半
    const mainTop = Math.min(xy(r, "b").y, xy(r, "c").y);
    expect(xy(r, "solo").x).toBeGreaterThan(xy(r, "b").x);
    expect(xy(r, "solo").y - mainTop).toBe((120 + GROUP_LAYOUT_GAP) / 2);
  });

  it("无组内连线时退化为宫格", () => {
    const members = [member("a", 0, 0), member("b", 400, 0), member("c", 0, 300)];
    const smart = arrangeGroup(members, [], "smart");
    const grid = arrangeGroup(members, [], "grid");

    for (const id of ["a", "b", "c"]) expect(xy(smart, id)).toEqual(xy(grid, id));
  });

  it("组外端点与自环不参与分层", () => {
    const members = [member("a", 0, 0), member("b", 0, 0)];
    const noisy = arrangeGroup(
      members,
      [link("a", "b"), link("a", "outside"), link("b", "b")],
      "smart",
    );
    const clean = arrangeGroup(members, [link("a", "b")], "smart");

    for (const id of ["a", "b"]) expect(xy(noisy, id)).toEqual(xy(clean, id));
  });

  it("结果整体归一到布局原点（成员不会压住组标题）", () => {
    const members = [member("a", 900, 700), member("b", 0, 0)];
    const r = arrangeGroup(members, [link("a", "b")], "smart");
    const xs = [...r.positions.values()].map((p) => p.x);
    const ys = [...r.positions.values()].map((p) => p.y);

    expect(Math.min(...xs)).toBe(ORIGIN.x);
    expect(Math.min(...ys)).toBe(ORIGIN.y);
  });
});
