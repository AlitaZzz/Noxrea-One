/**
 * 组内布局（纯函数，无 React / store 依赖，便于单测）。
 *
 * 排列核心在 `layout-modes.ts`（与选区布局共用）；本模块只负责组内坐标空间：
 * 成员 position 是组内相对坐标，布局结果整体归一到布局原点（padding + 标题栏，
 * 成员不可压住组标题），组框尺寸与 GroupNode 的 dynMinWidth / dynMinHeight
 * 恒等，组节点 position 不变。
 */
import type { Edge } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";
import {
  GROUP_NODE_MIN_HEIGHT,
  GROUP_NODE_MIN_WIDTH,
} from "@/lib/constants";

import { groupRectFromContent } from "./group-bounds";
import { collectLinks, type LayoutBox } from "./layered-layout";
import { arrangeBoxes, type CanvasLayoutMode } from "./layout-modes";
import { measureNode } from "./node-size";

export interface GroupLayoutResult {
  /** 成员 id → 组内相对坐标 */
  positions: Map<string, { x: number; y: number }>;
  /** 组框尺寸（与 GroupNode 的最小尺寸公式恒等） */
  width: number;
  height: number;
}

function toBoxes(members: AnyNode[]): LayoutBox[] {
  return members.map((m) => {
    const { width, height } = measureNode(m);
    return { id: m.id, x: m.position.x, y: m.position.y, width, height };
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

  // 布局原点即组框原点：成员相对坐标 = 绝对位置 − 组框位置。
  const groupRect = groupRectFromContent({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  });
  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, p] of placed) {
    positions.set(id, {
      x: p.x - groupRect.x,
      y: p.y - groupRect.y,
    });
  }

  return {
    positions,
    width: Math.max(GROUP_NODE_MIN_WIDTH, groupRect.width),
    height: Math.max(GROUP_NODE_MIN_HEIGHT, groupRect.height),
  };
}

/**
 * 组内布局入口：成员 + 画布连线 + 模式（缺省宫格）→ 成员相对坐标与组框尺寸。
 */
export function arrangeGroup(
  members: AnyNode[],
  edges: Edge[],
  mode: CanvasLayoutMode = "grid",
): GroupLayoutResult {
  const boxes = toBoxes(members);
  if (boxes.length === 0) {
    return { positions: new Map(), width: GROUP_NODE_MIN_WIDTH, height: GROUP_NODE_MIN_HEIGHT };
  }

  const memberIds = new Set(boxes.map((box) => box.id));
  const links = collectLinks(edges, (id) => (memberIds.has(id) ? id : undefined));
  return toGroupLayout(boxes, arrangeBoxes(boxes, links, mode));
}
