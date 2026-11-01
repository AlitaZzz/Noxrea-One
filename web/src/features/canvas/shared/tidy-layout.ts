/**
 * 画布整理布局（纯函数，无 React / store 依赖，便于单测）。
 *
 * 两种布局模式（默认 auto 按有无连线自动选择）：
 * - grid：行列网格，按读序填充，适合彼此无连线的素材板
 * - layer：分层布局，一列 = 一个拓扑层，上游在左、下游在右，适合有连线的画布
 *
 * 布局的原子单位是「块」而非单个节点：一个分组（parentId 结构关系）连同其
 * 成员视为一个整体块参与排序。组节点是顶层节点、成员 position 是组内相对
 * 坐标——移动组块只需产出组节点的新位置，成员相对偏移不变、视觉随组移动，
 * 因此 positions 结果只包含组节点与未分组节点。
 *
 * 只产出坐标，不修改入参、不触碰 store，由调用方负责压栈 / 落库 / 动画。
 */
import type { Edge } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, LAYOUT_GAP, TIDY_MAX_ROW_WIDTH } from "@/lib/constants";

import { groupMembers, isGroupNode, memberParentId } from "./group-membership";
import { collectLinks, packLayered } from "./layered-layout";
import { measureNode } from "./node-size";
import { sortBoxesByReading } from "./reading-order";

/** 单行最少列数 */
const MIN_COLUMNS = 1;

/**
 * 布局模式：
 * - auto：有连线走分层（上游在左、下游在右），无连线走网格
 * - layer：分层布局，一列 = 一个拓扑层，左 → 右
 * - grid：行列网格，按读序填充
 *
 * 注意：网格模式下链路会被折行，只适合彼此无连线的素材板。
 */
export type TidyMode = "auto" | "layer" | "grid";

export interface TidyOptions {
  /** 布局模式，默认 auto */
  mode?: TidyMode;
  /** grid 模式下的单行目标宽度（px），超出即换行，默认 TIDY_MAX_ROW_WIDTH */
  maxRowWidth?: number;
  /** > 0 时把块原点对齐到该网格步长（一般传 snapGridSize）。默认 0 = 不对齐 */
  snapSize?: number;
}

export interface TidyResult {
  /** nodeId → 新坐标（世界坐标）。只含组节点与未分组节点：成员相对坐标不变，
   *  视觉位置随所属组节点移动 */
  positions: Map<string, { x: number; y: number }>;
  /** 位置实际发生变化的节点数；为 0 表示无需整理 */
  movedCount: number;
}

/** 布局单元：一个独立节点，或一个「组 + 成员」整体块（成员随组平移） */
interface LayoutUnit {
  /** 块原点对应的节点 id（组块为组节点 id） */
  id: string;
  /** 块内需要产出新位置的节点（组块只有组节点自身；成员相对坐标不变） */
  offsets: Array<{ id: string; dx: number; dy: number }>;
  /** 组块的成员 id（供连线端点映射到块：跨组成员边等价于组块间的依赖边） */
  memberIds: string[];
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * 收集布局单元。
 * 分组 → 一个块（组节点自身产出位置；成员相对偏移决定块的尺寸与内容）；
 * 未分组节点 → 独立块。parentId 指向不存在的组时按未分组处理（脏数据兜底）。
 */
function collectUnits(nodes: AnyNode[]): LayoutUnit[] {
  const units: LayoutUnit[] = [];
  const groupIds = new Set(
    nodes.filter(isGroupNode).map((n) => n.id),
  );

  // 组块：组节点 position 是绝对坐标；成员 position 是组内相对坐标
  for (const group of nodes) {
    if (!isGroupNode(group)) continue;
    const gSize = measureNode(group);

    const memberIds: string[] = [];
    let contentW = 0;
    let contentH = 0;
    for (const n of groupMembers(nodes, group.id)) {
      memberIds.push(n.id);
      const s = measureNode(n);
      contentW = Math.max(contentW, n.position.x + s.width);
      contentH = Math.max(contentH, n.position.y + s.height);
    }

    units.push({
      id: group.id,
      offsets: [{ id: group.id, dx: 0, dy: 0 }],
      memberIds,
      // 组块必须容得下成员：取「组框尺寸」与「成员相对外接 + padding」的较大者
      width: Math.max(gSize.width, contentW + GROUP_NODE_PADDING),
      height: Math.max(gSize.height, contentH + GROUP_NODE_PADDING),
      x: group.position.x,
      y: group.position.y,
    });
  }

  // 独立节点；parentId 指向不存在的组时按未分组处理（脏数据兜底）
  for (const n of nodes) {
    if (isGroupNode(n)) continue;
    const parentId = memberParentId(n);
    if (parentId && groupIds.has(parentId)) continue;
    const s = measureNode(n);
    units.push({
      id: n.id,
      offsets: [{ id: n.id, dx: 0, dy: 0 }],
      memberIds: [],
      width: s.width,
      height: s.height,
      x: n.position.x,
      y: n.position.y,
    });
  }

  return units;
}

/**
 * 块级依赖：连线端点映射到所在块（成员边映射为组块间的边）。
 * 组内连线、自环与悬空边不构成块间上下游关系，由分层布局忽略。
 */
function blockLinks(units: LayoutUnit[], edges: Edge[]): Array<[string, string]> {
  const unitOfNode = new Map<string, string>();
  for (const u of units) {
    unitOfNode.set(u.id, u.id);
    for (const m of u.memberIds) unitOfNode.set(m, u.id);
  }

  return collectLinks(edges, (id) => unitOfNode.get(id));
}

/**
 * 行游标填充：行宽超上限或列数达上限即换行，行高取该行最高块。
 * 按块自身宽度累加（而非固定列宽），保证净间距恒为 LAYOUT_GAP；行内垂直
 * 居中——矮块相对行顶下移，与组内宫格同一口径。
 */
function packRows(
  units: LayoutUnit[],
  maxRowWidth: number,
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  if (units.length === 0) return placed;

  const avgWidth = units.reduce((sum, u) => sum + u.width, 0) / units.length;
  const widthLimited = Math.max(
    MIN_COLUMNS,
    Math.floor((maxRowWidth + LAYOUT_GAP) / (avgWidth + LAYOUT_GAP)),
  );
  // 上限再压一层 sqrt(n)：节点少时不至于摊成一条长横带
  const maxColumns = Math.max(
    MIN_COLUMNS,
    Math.min(widthLimited, Math.ceil(Math.sqrt(units.length))),
  );

  // 先按行宽 / 列数切行（与竖直定位无关），再逐行落位：行高要整行确定后才可知
  const rows: LayoutUnit[][] = [];
  let row: LayoutUnit[] = [];
  let cursorX = 0;
  for (const u of units) {
    if (row.length > 0 && (cursorX + u.width > maxRowWidth || row.length >= maxColumns)) {
      rows.push(row);
      row = [];
      cursorX = 0;
    }
    row.push(u);
    cursorX += u.width + LAYOUT_GAP;
  }
  if (row.length > 0) rows.push(row);

  let rowTop = 0;
  for (const current of rows) {
    let rowHeight = 0;
    for (const u of current) rowHeight = Math.max(rowHeight, u.height);

    let x = 0;
    for (const u of current) {
      placed.set(u.id, { x, y: rowTop + (rowHeight - u.height) / 2 });
      x += u.width + LAYOUT_GAP;
    }
    rowTop += rowHeight + LAYOUT_GAP;
  }

  return placed;
}

/**
 * 计算画布整理后的各节点坐标。
 * 结果整体平移到原内容包围盒的左上角，避免整理后内容在视口里「飞走」。
 */
export function computeTidyLayout(
  nodes: AnyNode[],
  edges: Edge[],
  options: TidyOptions = {},
): TidyResult {
  const {
    mode = "auto",
    maxRowWidth = TIDY_MAX_ROW_WIDTH,
    snapSize = 0,
  } = options;

  const units = collectUnits(nodes);
  // 0 / 1 个块时整理没有意义
  if (units.length < 2) {
    return { positions: new Map(), movedCount: 0 };
  }

  // 有连线的画布必须走分层：网格填充会在行末折行，把下游甩到上游下方
  const hasEdges = edges.some((e) => e.source !== e.target);
  const useLayer = mode === "layer" || (mode === "auto" && hasEdges);
  const placed = useLayer
    ? packLayered(units, blockLinks(units, edges), { gap: LAYOUT_GAP, columnGap: LAYOUT_GAP })
    : packRows(sortBoxesByReading(units), maxRowWidth);

  let originX = Infinity;
  let originY = Infinity;
  for (const u of units) {
    originX = Math.min(originX, u.x);
    originY = Math.min(originY, u.y);
  }
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    originX = 0;
    originY = 0;
  }

  const snap = (v: number) => (snapSize > 0 ? Math.round(v / snapSize) * snapSize : v);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const positions = new Map<string, { x: number; y: number }>();
  let movedCount = 0;

  for (const u of units) {
    const p = placed.get(u.id);
    if (!p) continue;
    // snap 作用于最终坐标（而非相对量），保证开启吸附时节点真正落在网格上
    const baseX = snap(originX + p.x);
    const baseY = snap(originY + p.y);
    for (const o of u.offsets) {
      const node = nodeById.get(o.id);
      if (!node) continue;
      const next = { x: baseX + o.dx, y: baseY + o.dy };
      if (
        Math.abs(next.x - node.position.x) > 0.5 ||
        Math.abs(next.y - node.position.y) > 0.5
      ) {
        movedCount += 1;
      }
      positions.set(o.id, next);
    }
  }

  return { positions, movedCount };
}
