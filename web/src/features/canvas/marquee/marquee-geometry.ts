/**
 * 框选冻结几何索引与命中查询。
 *
 * 框选手势激活时对当前节点集合建立一次索引，手势期间几何不重建：节点在
 * 手势中被移动、改尺寸都不影响本次命中结果。索引为 uniform grid（单元
 * 256 flow 单位），跨单元过多的节点进入大节点列表，每次查询都检查；查询
 * 覆盖单元数超过上限时退化为全量线性扫描。规则与即梦一致：
 *
 * - 普通节点与查询矩形相交即命中；
 * - 组必须被查询矩形完全包含才命中，部分相交不命中；
 * - 最终集合排除「已选中组」的成员。
 *
 * 只做命中判定；坐标与尺寸换算复用 `shared/group-bounds.ts`、
 * `shared/tidy-layout.ts`，不复制规则。完整业务规则见
 * specs/canvas-marquee-gesture-session.md。
 */
import type { Rect } from "@/features/canvas/shared/geometry";
import { buildNodeIndex, nodeAbsolutePosition } from "@/features/canvas/shared/group-bounds";
import { isGroupNode, memberParentId } from "@/features/canvas/shared/group-membership";
import { measureNode } from "@/features/canvas/shared/tidy-layout";
import type { AnyNode } from "@/features/canvas/types";

/** uniform grid 单元边长（flow 单位）。 */
export const MARQUEE_CELL_SIZE = 256;

/** 单个节点覆盖的单元数超过该值时进入大节点列表，每次查询都检查。 */
const LARGE_ENTRY_CELL_LIMIT = 64;

/** 查询矩形覆盖的单元数超过该值时退化为全量线性扫描。 */
const LINEAR_SCAN_CELL_LIMIT = 4096;

export interface MarqueeGeometryEntry {
  id: string;
  /** 绝对 flow 坐标（组内成员已叠加父组位移）。 */
  rect: Rect;
  isGroup: boolean;
  parentId: string | null;
}

/** 冻结索引：只读数据，查询所需的去重草稿由模块内部持有。 */
export interface MarqueeGeometryIndex {
  readonly entries: readonly MarqueeGeometryEntry[];
  readonly cells: ReadonlyMap<string, readonly number[]>;
  readonly largeEntries: readonly number[];
  readonly entryById: ReadonlyMap<string, MarqueeGeometryEntry>;
  readonly groupIds: ReadonlySet<string>;
}

/** 每次查询复用同一份去重草稿，避免逐帧分配；与冻结索引分离。 */
interface QueryScratch {
  readonly stamps: Int32Array;
  stamp: number;
}

const scratchByIndex = new WeakMap<MarqueeGeometryIndex, QueryScratch>();

function scratchFor(index: MarqueeGeometryIndex): QueryScratch {
  let scratch = scratchByIndex.get(index);
  if (!scratch) {
    scratch = { stamps: new Int32Array(index.entries.length), stamp: 0 };
    scratchByIndex.set(index, scratch);
  }
  return scratch;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

interface CellRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function cellRange(rect: Rect): CellRange {
  return {
    minX: Math.floor(rect.x / MARQUEE_CELL_SIZE),
    minY: Math.floor(rect.y / MARQUEE_CELL_SIZE),
    maxX: Math.floor((rect.x + rect.width) / MARQUEE_CELL_SIZE),
    maxY: Math.floor((rect.y + rect.height) / MARQUEE_CELL_SIZE),
  };
}

/** 矩形覆盖的单元数（含两端）；用于超限退化判定 */
function cellSpan(range: CellRange): number {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
}

/**
 * 建立冻结索引。跳过 `hidden` 与 `selectable === false` 的节点：它们不参与
 * 框选，也不能被命中。
 */
export function buildMarqueeGeometryIndex(nodes: AnyNode[]): MarqueeGeometryIndex {
  const nodeById = buildNodeIndex(nodes);
  const entries: MarqueeGeometryEntry[] = [];
  const entryById = new Map<string, MarqueeGeometryEntry>();
  const groupIds = new Set<string>();

  for (const node of nodes) {
    if (node.hidden === true || node.selectable === false) continue;
    const absolute = nodeAbsolutePosition(node, nodeById);
    const size = measureNode(node);
    const isGroup = isGroupNode(node);
    const entry: MarqueeGeometryEntry = {
      id: node.id,
      rect: { x: absolute.x, y: absolute.y, width: size.width, height: size.height },
      isGroup,
      parentId: memberParentId(node) ?? null,
    };
    entries.push(entry);
    entryById.set(entry.id, entry);
    if (isGroup) groupIds.add(entry.id);
  }

  const cells = new Map<string, number[]>();
  const largeEntries: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const range = cellRange(entries[index].rect);
    if (cellSpan(range) > LARGE_ENTRY_CELL_LIMIT) {
      largeEntries.push(index);
      continue;
    }
    for (let cy = range.minY; cy <= range.maxY; cy += 1) {
      for (let cx = range.minX; cx <= range.maxX; cx += 1) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(index);
        else cells.set(key, [index]);
      }
    }
  }

  return { entries, cells, largeEntries, entryById, groupIds };
}

/**
 * 遍历与查询矩形可能相交的条目索引。结果可能包含实际不相交的条目，由调用方
 * 做最终判定；每个条目在一次查询中最多访问一次。
 */
function forEachCandidate(
  index: MarqueeGeometryIndex,
  scratch: QueryScratch,
  rect: Rect,
  visit: (entryIndex: number) => void,
): void {
  const range = cellRange(rect);
  if (cellSpan(range) > LINEAR_SCAN_CELL_LIMIT) {
    for (let i = 0; i < index.entries.length; i += 1) visit(i);
    return;
  }

  scratch.stamp = scratch.stamp >= 0x7fffffff ? 1 : scratch.stamp + 1;
  if (scratch.stamp === 1) scratch.stamps.fill(0);
  const stamp = scratch.stamp;

  for (let cy = range.minY; cy <= range.maxY; cy += 1) {
    for (let cx = range.minX; cx <= range.maxX; cx += 1) {
      const bucket = index.cells.get(cellKey(cx, cy));
      if (!bucket) continue;
      for (const entryIndex of bucket) {
        if (scratch.stamps[entryIndex] === stamp) continue;
        scratch.stamps[entryIndex] = stamp;
        visit(entryIndex);
      }
    }
  }
  for (const entryIndex of index.largeEntries) {
    if (scratch.stamps[entryIndex] === stamp) continue;
    scratch.stamps[entryIndex] = stamp;
    visit(entryIndex);
  }
}

function intersects(rect: Rect, other: Rect): boolean {
  return (
    other.x < rect.x + rect.width &&
    other.x + other.width > rect.x &&
    other.y < rect.y + rect.height &&
    other.y + other.height > rect.y
  );
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/**
 * 计算本次框选的命中集合。
 *
 * `baseline` 为追加选择（Shift/Ctrl/Meta）的起点，否则传空集合。返回值包含
 * baseline 中仍有效的条目、完全包含的组、以及相交的普通节点；已选中组的
 * 成员不进入返回值。
 */
export function queryMarqueeSelection(
  index: MarqueeGeometryIndex,
  rect: Rect,
  baseline: ReadonlySet<string>,
): Set<string> {
  const query = normalizeRect(rect);
  const scratch = scratchFor(index);
  const hitGroups = new Set<string>();
  const hitNodes: MarqueeGeometryEntry[] = [];

  forEachCandidate(index, scratch, query, (entryIndex) => {
    const entry = index.entries[entryIndex];
    if (entry.isGroup) {
      if (contains(query, entry.rect)) hitGroups.add(entry.id);
    } else if (intersects(query, entry.rect)) {
      hitNodes.push(entry);
    }
  });

  const selected = new Set(baseline);
  const selectedGroups = new Set<string>();
  for (const id of baseline) {
    if (index.groupIds.has(id)) selectedGroups.add(id);
  }
  for (const id of hitGroups) {
    selected.add(id);
    selectedGroups.add(id);
  }

  // 已选中组的成员不单独选中：组本身就是选择单元。
  for (const id of [...selected]) {
    const entry = index.entryById.get(id);
    if (entry?.parentId && selectedGroups.has(entry.parentId)) selected.delete(id);
  }

  for (const entry of hitNodes) {
    if (entry.parentId && selectedGroups.has(entry.parentId)) continue;
    selected.add(entry.id);
  }

  return selected;
}
