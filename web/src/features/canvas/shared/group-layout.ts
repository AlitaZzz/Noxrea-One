/**
 * 组内布局（纯函数，无 React / store 依赖，便于单测）。
 *
 * 四种模式：
 * - grid：宫格，按读序逐行填充，行内紧凑 + 垂直居中；
 * - horizontal / vertical：单行 / 单列，读序排列，跨轴居中；
 * - smart：按组内连线分层（上游在左、下游在右），无组内连线时退化为宫格。
 *
 * 成员 position 是组内相对坐标，布局直接在这个空间里算。结果整体归一到布局
 * 原点（padding + 标题栏，成员不可压住组标题），组框尺寸与 GroupNode 的
 * dynMinWidth / dynMinHeight 恒等，组节点 position 不变。
 */
import type { Edge } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";
import {
  GROUP_LAYOUT_COLUMN_GAP,
  GROUP_LAYOUT_GAP,
  GROUP_NODE_MIN_HEIGHT,
  GROUP_NODE_MIN_WIDTH,
  GROUP_NODE_PADDING,
  NODE_TITLE_HEIGHT,
} from "@/lib/constants";

import { collectLinks, type LayoutBox, packLayered } from "./layered-layout";
import { measureNode } from "./node-size";
import { sortBoxesByReading } from "./reading-order";

export type GroupLayoutMode = "smart" | "grid" | "horizontal" | "vertical";

export interface GroupLayoutResult {
  /** 成员 id → 组内相对坐标 */
  positions: Map<string, { x: number; y: number }>;
  /** 组框尺寸（与 GroupNode 的最小尺寸公式恒等） */
  width: number;
  height: number;
}

/** 布局原点：padding + 标题栏（成员不可压住组标题） */
const LAYOUT_ORIGIN = { x: GROUP_NODE_PADDING, y: NODE_TITLE_HEIGHT + GROUP_NODE_PADDING };

function toBoxes(members: AnyNode[]): LayoutBox[] {
  return members.map((m) => {
    const { width, height } = measureNode(m);
    return { id: m.id, x: m.position.x, y: m.position.y, width, height };
  });
}

/** 宫格：按读序逐行填充，行内紧凑游标 + 垂直居中 */
function arrangeGrid(boxes: LayoutBox[]): Map<string, { x: number; y: number }> {
  const sorted = sortBoxesByReading(boxes);
  const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const placed = new Map<string, { x: number; y: number }>();

  let rowTop = 0;
  for (let i = 0; i < sorted.length; i += columns) {
    const row = sorted.slice(i, i + columns);
    let rowHeight = 0;
    for (const box of row) rowHeight = Math.max(rowHeight, box.height);

    let cursorX = 0;
    for (const box of row) {
      // 行内垂直居中：矮成员相对行顶下移，顶对齐会让同行成员视觉上浮起
      placed.set(box.id, { x: cursorX, y: rowTop + (rowHeight - box.height) / 2 });
      cursorX += box.width + GROUP_LAYOUT_GAP;
    }
    rowTop += rowHeight + GROUP_LAYOUT_GAP;
  }

  return placed;
}

/** 水平：按读序单行排列，y 相对最高成员居中 */
function arrangeHorizontal(boxes: LayoutBox[]): Map<string, { x: number; y: number }> {
  const sorted = sortBoxesByReading(boxes);
  const maxHeight = Math.max(...sorted.map((box) => box.height));
  const placed = new Map<string, { x: number; y: number }>();

  let cursorX = 0;
  for (const box of sorted) {
    placed.set(box.id, { x: cursorX, y: (maxHeight - box.height) / 2 });
    cursorX += box.width + GROUP_LAYOUT_GAP;
  }

  return placed;
}

/** 垂直：按读序单列排列，x 相对最宽成员居中 */
function arrangeVertical(boxes: LayoutBox[]): Map<string, { x: number; y: number }> {
  const sorted = sortBoxesByReading(boxes);
  const maxWidth = Math.max(...sorted.map((box) => box.width));
  const placed = new Map<string, { x: number; y: number }>();

  let cursorY = 0;
  for (const box of sorted) {
    placed.set(box.id, { x: (maxWidth - box.width) / 2, y: cursorY });
    cursorY += box.height + GROUP_LAYOUT_GAP;
  }

  return placed;
}

/**
 * 智能布局：组内连线 → 分层。
 *
 * 上游在左、下游在右；环内成员与孤立成员单列排到主图右侧，不打断主链路。
 * 没有组内连线时「智能」就是整齐排列，直接退化为宫格。
 */
function arrangeSmart(boxes: LayoutBox[], edges: Edge[]): Map<string, { x: number; y: number }> {
  const memberIds = new Set(boxes.map((box) => box.id));
  const links = collectLinks(edges, (id) => (memberIds.has(id) ? id : undefined));
  if (links.length === 0) return arrangeGrid(boxes);

  return packLayered(boxes, links, {
    gap: GROUP_LAYOUT_GAP,
    columnGap: GROUP_LAYOUT_COLUMN_GAP,
  });
}

/** 把内容空间归一到布局原点，并按内容包围盒给出组框尺寸 */
function toGroupLayout(
  boxes: LayoutBox[],
  placed: Map<string, { x: number; y: number }>,
): GroupLayoutResult {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    const p = placed.get(box.id);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + box.width);
    maxY = Math.max(maxY, p.y + box.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { positions: new Map(), width: GROUP_NODE_MIN_WIDTH, height: GROUP_NODE_MIN_HEIGHT };
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, p] of placed) {
    positions.set(id, {
      x: LAYOUT_ORIGIN.x + p.x - minX,
      y: LAYOUT_ORIGIN.y + p.y - minY,
    });
  }

  return {
    positions,
    width: Math.max(GROUP_NODE_MIN_WIDTH, maxX - minX + GROUP_NODE_PADDING * 2),
    height: Math.max(
      GROUP_NODE_MIN_HEIGHT,
      maxY - minY + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2,
    ),
  };
}

/** 模式 → 排布实现（相对坐标，未归一化） */
const LAYOUT_ARRANGERS: Record<
  GroupLayoutMode,
  (boxes: LayoutBox[], edges: Edge[]) => Map<string, { x: number; y: number }>
> = {
  grid: arrangeGrid,
  smart: arrangeSmart,
  horizontal: arrangeHorizontal,
  vertical: arrangeVertical,
};

/**
 * 组内布局入口：成员 + 画布连线 + 模式（缺省宫格）→ 成员相对坐标与组框尺寸。
 */
export function arrangeGroup(
  members: AnyNode[],
  edges: Edge[],
  mode: GroupLayoutMode = "grid",
): GroupLayoutResult {
  const boxes = toBoxes(members);
  if (boxes.length === 0) {
    return { positions: new Map(), width: GROUP_NODE_MIN_WIDTH, height: GROUP_NODE_MIN_HEIGHT };
  }

  return toGroupLayout(boxes, LAYOUT_ARRANGERS[mode](boxes, edges));
}
