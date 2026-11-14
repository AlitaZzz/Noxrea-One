/**
 * 画布布局排列核心（纯函数，无 React / store 依赖）。
 *
 * 组内布局与选区布局共用这一份实现：输入同一坐标空间的节点盒子与布局单元
 * 依赖边，输出以排布原点为 (0,0) 的左上角坐标。调用方各自负责 finalize——
 * 组内布局归一化到组框，选区布局按参与单元包围盒中心平移。
 *
 * 四种模式：
 * - grid：宫格，按读序逐行填充，行内紧凑 + 垂直居中；
 * - horizontal / vertical：单行 / 单列，读序排列，跨轴居中；
 * - smart：按依赖边分层（上游在左、下游在右），无依赖边时退化为宫格。
 *
 * 语义与常量见 specs/canvas-group-layout.md 4.2–4.5、4.8。
 */
import {
  GROUP_LAYOUT_COLUMN_GAP,
  GROUP_LAYOUT_GAP,
} from "@/lib/constants";

import { type LayoutBox, packLayered } from "./layered-layout";
import { sortBoxesByReading } from "./reading-order";

export type CanvasLayoutMode = "smart" | "grid" | "horizontal" | "vertical";

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
 * 智能布局：依赖边 → 分层。
 *
 * 上游在左、下游在右；环内单元与孤立单元单列排到主图右侧，不打断主链路。
 * 没有依赖边时「智能」就是整齐排列，直接退化为宫格。
 */
function arrangeSmart(
  boxes: LayoutBox[],
  links: Array<[string, string]>,
): Map<string, { x: number; y: number }> {
  if (links.length === 0) return arrangeGrid(boxes);

  return packLayered(boxes, links, {
    gap: GROUP_LAYOUT_GAP,
    columnGap: GROUP_LAYOUT_COLUMN_GAP,
  });
}

/**
 * 排列入口：节点盒子 + 单元间依赖边 + 模式 → 左上角坐标。
 *
 * 输入坐标空间由调用方决定（组内相对或世界），输出以排布原点为 (0,0)。
 * 连线端点不在 boxes 中或两端相同时由 `collectLinks` 在调用前过滤。
 */
export function arrangeBoxes(
  boxes: LayoutBox[],
  links: Array<[string, string]>,
  mode: CanvasLayoutMode,
): Map<string, { x: number; y: number }> {
  switch (mode) {
    case "grid":
      return arrangeGrid(boxes);
    case "horizontal":
      return arrangeHorizontal(boxes);
    case "vertical":
      return arrangeVertical(boxes);
    case "smart":
      return arrangeSmart(boxes, links);
  }
}
