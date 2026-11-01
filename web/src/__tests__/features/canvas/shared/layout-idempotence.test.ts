/**
 * 布局幂等测试：同一拓扑与节点尺寸下，对布局结果再次执行必须得到同一坐标。
 *
 * 布局把读序同时用作「输入顺序」与「输出再次读序的来源」，两者不一致时会
 * 在两次执行之间来回换位（同层支路翻转、宫格行内高矮混排换列）。这里固定
 * 已知会暴露该问题的形状，并用确定性随机拓扑做回归。
 */
import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import {
  arrangeGroup,
  type GroupLayoutMode,
  type GroupLayoutResult,
} from "@/features/canvas/shared/group-layout";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

// ── 构造辅助 ──────────────────────────────────────────────

function member(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  type: string = NODE_TYPE.VIDEO,
): AnyNode {
  return {
    id,
    type,
    position: { x, y },
    style: { width, height },
    data: { label: id },
    parentId: "g",
  } as unknown as AnyNode;
}

function link(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

function apply(members: AnyNode[], result: GroupLayoutResult): AnyNode[] {
  return members.map((m) => ({ ...m, position: result.positions.get(m.id) ?? m.position }));
}

function snapshot(result: GroupLayoutResult): Array<[string, { x: number; y: number }]> {
  return [...result.positions.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** 连续执行三次：第 2、3 次都必须与第 1 次完全相同（含组框尺寸） */
function expectStable(members: AnyNode[], edges: Edge[], mode: GroupLayoutMode) {
  const first = arrangeGroup(members, edges, mode);
  const second = arrangeGroup(apply(members, first), edges, mode);
  const third = arrangeGroup(apply(apply(members, first), second), edges, mode);

  expect(snapshot(second)).toEqual(snapshot(first));
  expect(snapshot(third)).toEqual(snapshot(first));
  expect(second.width).toBe(first.width);
  expect(second.height).toBe(first.height);
}

/** mulberry32：确定性伪随机 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 固定形状 ──────────────────────────────────────────────

describe("布局幂等（固定形状）", () => {
  it("智能：链路 + 两个无连线音频成员", () => {
    const members = [
      member("v1", 0, 0, 600, 428),
      member("v2", 0, 500, 600, 428),
      member("a1", 700, 0, 420, 237, NODE_TYPE.AUDIO),
      member("a2", 700, 300, 420, 237, NODE_TYPE.AUDIO),
    ];
    expectStable(members, [link("v1", "v2")], "smart");
  });

  it("智能：菱形 + 环内成员 + 孤立成员", () => {
    const members = [
      member("a", 0, 0, 200, 120),
      member("b", 400, 100, 320, 200),
      member("c", 400, 400, 200, 120),
      member("d", 900, 200, 600, 428),
      member("x", 200, 800, 420, 237, NODE_TYPE.AUDIO),
      member("y", 200, 1100, 420, 237, NODE_TYPE.AUDIO),
    ];
    expectStable(
      members,
      [
        link("a", "b"),
        link("a", "c"),
        link("b", "d"),
        link("c", "d"),
        link("x", "y"),
        link("y", "x"),
      ],
      "smart",
    );
  });

  it("智能无组内连线（退化为宫格）：高矮混排的居中下移不改变读序", () => {
    // 矮成员 200x120 被行内居中下移后，顶边与 800x500 高成员拉开，
    // 按顶边分带时会被判成另一行，下一次填充顺序随之互换
    const members = [
      member("n1", 700, 500, 320, 200),
      member("n2", 2800, 500, 800, 500),
      member("n0", 2100, 2000, 200, 120),
    ];
    expectStable(members, [], "smart");
    expectStable(members, [], "grid");
  });

  it("水平与垂直：高矮混排保持读序", () => {
    const members = [
      member("a", 0, 0, 200, 120),
      member("b", 400, 0, 200, 300),
      member("c", 800, 0, 420, 237, NODE_TYPE.AUDIO),
    ];
    expectStable(members, [], "horizontal");
    expectStable(members, [], "vertical");
  });
});

// ── 确定性随机拓扑 ────────────────────────────────────────

describe("布局幂等（随机拓扑）", () => {
  it("四种模式连续执行结果一致", () => {
    const sizes = [
      [600, 428],
      [420, 237], // 音频
      [320, 200],
      [200, 120],
      [800, 500],
    ] as const;
    const modes: GroupLayoutMode[] = ["smart", "grid", "horizontal", "vertical"];
    const failures: string[] = [];

    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = rng(seed);
      const count = 3 + Math.floor(rand() * 9);
      const members: AnyNode[] = [];
      for (let i = 0; i < count; i += 1) {
        const [width, height] = sizes[Math.floor(rand() * sizes.length)];
        members.push(
          member(
            `n${i}`,
            Math.floor(rand() * 5) * 700,
            Math.floor(rand() * 5) * 500,
            width,
            height,
            width === 420 ? NODE_TYPE.AUDIO : NODE_TYPE.VIDEO,
          ),
        );
      }
      const edges: Edge[] = [];
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) {
          // 正向边构成 DAG，反向边制造环路
          if (rand() < 0.18) edges.push(link(`n${i}`, `n${j}`));
          if (rand() < 0.05) edges.push(link(`n${j}`, `n${i}`));
        }
      }

      for (const mode of modes) {
        const first = arrangeGroup(members, edges, mode);
        const second = arrangeGroup(apply(members, first), edges, mode);
        const third = arrangeGroup(apply(apply(members, first), second), edges, mode);
        const stable =
          JSON.stringify(snapshot(second)) === JSON.stringify(snapshot(first)) &&
          JSON.stringify(snapshot(third)) === JSON.stringify(snapshot(first));
        if (!stable) failures.push(`seed ${seed} / ${mode}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
