/**
 * 画布整理布局（纯函数，无 React / store 依赖，便于单测）。
 *
 * 两种布局模式（默认 auto 按有无连线自动选择）：
 * - grid：行列网格，按读序填充，适合彼此无连线的素材板
 * - layer：分层布局，一列 = 一个拓扑层，上游在左、下游在右，适合有连线的画布
 *
 * 布局的原子单位是「块」而非单个节点：一个分组（groupId）连同其成员
 * 视为一个整体块参与排序与平移，成员保持相对位置 —— 因为组框的坐标是
 * 独立的，单独移动成员会让成员脱离组框。
 *
 * 只产出坐标，不修改入参、不触碰 store，由调用方负责压栈 / 落库 / 动画。
 */
import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { Edge } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, LAYOUT_GAP, NODE_TYPE, TIDY_MAX_ROW_WIDTH } from "@/lib/constants";

/** 节点尺寸兜底（未测量到时的猜测值） */
const FALLBACK_WIDTH = 200;
const FALLBACK_HEIGHT = 120;

/** 读序分带的最小带高，防止节点极矮时把所有节点并成一带 */
const MIN_BAND_HEIGHT = 60;

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
  /** nodeId → 新坐标（世界坐标） */
  positions: Map<string, { x: number; y: number }>;
  /** 位置实际发生变化的节点数；为 0 表示无需整理 */
  movedCount: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 布局单元：一个独立节点，或一个「组 + 成员」整体块 */
interface LayoutUnit {
  /** 块原点对应的节点 id（组块为组节点 id） */
  id: string;
  /** 块内所有节点相对块原点的偏移（组节点自身偏移为 0,0） */
  offsets: Array<{ id: string; dx: number; dy: number }>;
  width: number;
  height: number;
  x: number;
  y: number;
}

/** 转正数，NaN / 0 / 负数一律视为无效值以走回退链 */
function toNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 取节点尺寸：实测值 > style 显式值 > 兜底猜测 */
export function measureNode(node: AnyNode): Size {
  return {
    width: toNumber(node.measured?.width) ?? toNumber(node.style?.width) ?? FALLBACK_WIDTH,
    height: toNumber(node.measured?.height) ?? toNumber(node.style?.height) ?? FALLBACK_HEIGHT,
  };
}

/** 读取逻辑分组归属；组节点自身不参与分组，恒为 undefined */
function getGroupId(node: AnyNode): string | undefined {
  if (node.type === NODE_TYPE.GROUP) return undefined;
  return (node.data as { groupId?: string } | undefined)?.groupId;
}

/**
 * 收集布局单元。
 * 分组 → 一个块（组节点 + 成员）；未分组节点 → 独立块。
 */
function collectUnits(nodes: AnyNode[]): LayoutUnit[] {
  const units: LayoutUnit[] = [];
  const groupIds = new Set(
    nodes.filter((n) => n.type === NODE_TYPE.GROUP).map((n) => n.id),
  );

  // 组块
  for (const group of nodes) {
    if (group.type !== NODE_TYPE.GROUP) continue;
    const gx = group.position.x;
    const gy = group.position.y;
    const gSize = measureNode(group);

    const offsets: Array<{ id: string; dx: number; dy: number }> = [
      { id: group.id, dx: 0, dy: 0 },
    ];
    let contentW = 0;
    let contentH = 0;

    for (const n of nodes) {
      if (n.type === NODE_TYPE.GROUP) continue;
      if (getGroupId(n) !== group.id) continue;
      const s = measureNode(n);
      offsets.push({ id: n.id, dx: n.position.x - gx, dy: n.position.y - gy });
      contentW = Math.max(contentW, n.position.x - gx + s.width);
      contentH = Math.max(contentH, n.position.y - gy + s.height);
    }

    units.push({
      id: group.id,
      offsets,
      // 组框必须包住成员：取「组框尺寸」与「成员外接矩形 + padding」的较大者
      width: Math.max(gSize.width, contentW + GROUP_NODE_PADDING),
      height: Math.max(gSize.height, contentH + GROUP_NODE_PADDING),
      x: gx,
      y: gy,
    });
  }

  // 独立节点；groupId 指向不存在的组时按未分组处理（脏数据兜底）
  for (const n of nodes) {
    if (n.type === NODE_TYPE.GROUP) continue;
    const gid = getGroupId(n);
    if (gid && groupIds.has(gid)) continue;
    const s = measureNode(n);
    units.push({
      id: n.id,
      offsets: [{ id: n.id, dx: 0, dy: 0 }],
      width: s.width,
      height: s.height,
      x: n.position.x,
      y: n.position.y,
    });
  }

  return units;
}

/** 读序：按 y 分带（同一横带内按 x 升序），贴合视觉阅读顺序 */
function sortByReading(units: LayoutUnit[]): LayoutUnit[] {
  if (units.length <= 1) return [...units];

  const avgHeight = units.reduce((sum, u) => sum + u.height, 0) / units.length;
  // 带高取平均高度的一半：既容得下同一行内的轻微错位，又不会把上下两行并成一行
  const bandHeight = Math.max(MIN_BAND_HEIGHT, avgHeight / 2);

  const byY = [...units].sort((a, b) => a.y - b.y);
  const bands: LayoutUnit[][] = [];
  let band: LayoutUnit[] = [];
  let bandTop = 0;

  for (const u of byY) {
    if (band.length === 0) {
      band = [u];
      bandTop = u.y;
      continue;
    }
    if (u.y - bandTop < bandHeight) {
      band.push(u);
    } else {
      bands.push(band);
      band = [u];
      bandTop = u.y;
    }
  }
  if (band.length > 0) bands.push(band);

  return bands.flatMap((b) => [...b].sort((a, b2) => a.x - b2.x));
}

/**
 * 用 dagre 做分层布局（Sugiyama：层分配 + 交叉最小化 + 坐标分配）。
 *
 * 主 DAG 交给 dagre：上游在左、下游在右，同层内顺序由 dagre 的重心/中位数
 * 启发式重排，连线交叉显著减少，是 React Flow 官方 Auto Layout 同款实现。
 *
 * 环内块与孤立块不喂给 dagre（dagre 要求无环），而是单列排到主图最右侧，
 * 不打断主链路。
 */
function packWithDagre(
  units: LayoutUnit[],
  edges: Edge[],
  readingIndex: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  if (units.length === 0) return placed;

  // —— 构建块级依赖图（组成员映射到组块；组内连线、自环、悬空边忽略）——
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const u of units) {
    outgoing.set(u.id, new Set());
    indegree.set(u.id, 0);
  }
  const unitOfNode = new Map<string, string>();
  for (const u of units) {
    for (const o of u.offsets) unitOfNode.set(o.id, u.id);
  }
  for (const e of edges) {
    const s = unitOfNode.get(e.source);
    const t = unitOfNode.get(e.target);
    if (!s || !t || s === t) continue;
    const set = outgoing.get(s)!;
    if (set.has(t)) continue; // 平行边去重
    set.add(t);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }

  const byReading = (a: LayoutUnit, b: LayoutUnit) =>
    (readingIndex.get(a.id) ?? 0) - (readingIndex.get(b.id) ?? 0);

  // Kahn 判环：未访问到的块卡在环里，不能喂给 dagre
  const deg = new Map(indegree);
  const visited = new Set<string>();
  const ready = units
    .filter((u) => (deg.get(u.id) ?? 0) === 0)
    .map((u) => u.id)
    .sort((a, b) => (readingIndex.get(a) ?? 0) - (readingIndex.get(b) ?? 0));
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      const d = (deg.get(next) ?? 0) - 1;
      deg.set(next, d);
      if (d <= 0 && !visited.has(next)) {
        ready.push(next);
        ready.sort((a, b) => (readingIndex.get(a) ?? 0) - (readingIndex.get(b) ?? 0));
      }
    }
  }

  const main: LayoutUnit[] = [];
  const tail: LayoutUnit[] = [];
  for (const u of units) {
    const noIn = (indegree.get(u.id) ?? 0) === 0;
    const noOut = (outgoing.get(u.id)?.size ?? 0) === 0;
    if (!visited.has(u.id) || (noIn && noOut)) tail.push(u);
    else main.push(u);
  }
  tail.sort(byReading);

  // —— 主 DAG 交给 dagre ——
  let mainWidth = 0;
  let mainHeight = 0;
  if (main.length > 0) {
    const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
    g.setGraph({ rankdir: "LR", nodesep: LAYOUT_GAP, ranksep: LAYOUT_GAP });
    g.setDefaultEdgeLabel(() => ({}));
    for (const u of main) g.setNode(u.id, { width: u.width, height: u.height });
    for (const [s, ts] of outgoing) {
      if (!g.hasNode(s)) continue;
      for (const t of ts) if (g.hasNode(t)) g.setEdge(s, t);
    }
    dagre.layout(g);

    for (const u of main) {
      const n = g.node(u.id)!;
      // dagre 给中心点，转左上角（布局后 x/y 必存在）
      placed.set(u.id, { x: n.x! - u.width / 2, y: n.y! - u.height / 2 });
    }
    const graph = g.graph();
    mainWidth = graph.width ?? 0;
    mainHeight = graph.height ?? 0;
  }

  // —— 环内块与孤立块：单列垂直排到主图右侧，并相对主图垂直居中 ——
  const tailHeight =
    tail.length === 0
      ? 0
      : tail.reduce((sum, u) => sum + u.height, 0) + LAYOUT_GAP * (tail.length - 1);
  const tailX = mainWidth > 0 ? mainWidth + LAYOUT_GAP : 0;
  let tailY = tail.length > 0 ? Math.max(0, (mainHeight - tailHeight) / 2) : 0;
  for (const u of tail) {
    placed.set(u.id, { x: tailX, y: tailY });
    tailY += u.height + LAYOUT_GAP;
  }

  return placed;
}

/**
 * 行游标填充：行宽超上限或列数达上限即换行，行高取该行最高块。
 * 按块自身宽度累加（而非固定列宽），保证净间距恒为 LAYOUT_GAP。
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

  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;
  let column = 0;

  for (const u of units) {
    if (column > 0 && (cursorX + u.width > maxRowWidth || column >= maxColumns)) {
      cursorX = 0;
      cursorY += rowMaxH + LAYOUT_GAP;
      rowMaxH = 0;
      column = 0;
    }
    placed.set(u.id, { x: cursorX, y: cursorY });
    cursorX += u.width + LAYOUT_GAP;
    rowMaxH = Math.max(rowMaxH, u.height);
    column += 1;
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

  const reading = sortByReading(units);
  const readingIndex = new Map(reading.map((u, i) => [u.id, i]));

  // 有连线的画布必须走分层：网格填充会在行末折行，把下游甩到上游下方
  const hasEdges = edges.some((e) => e.source !== e.target);
  const useLayer = mode === "layer" || (mode === "auto" && hasEdges);
  const placed = useLayer
    ? packWithDagre(units, edges, readingIndex)
    : packRows(reading, maxRowWidth);

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
