/**
 * 拖动吸附的引擎适配层（预览与提交共用）。
 *
 * 会话按基准快照提供移动集的绝对盒与原始位移，这里构建并集主体、候选目标
 * 与吸附帧；吸附计算由 `shared/snap-engine.ts` 完成，最终偏移按相对坐标
 * 应用回拖动项。规则见 specs/canvas-snap-alignment.md。
 */
import type { Point } from "@/features/canvas/shared/geometry";
import { nodeAbsolutePosition } from "@/features/canvas/shared/group-bounds";
import {
  isValidSnapBounds,
  shiftBounds,
  type SnapAxis,
  type SnapBounds,
  type SnapFrame,
  type SnapSessionState,
  type SnapTarget,
} from "@/features/canvas/shared/snap-engine";
import type { AnyNode } from "@/features/canvas/types";

export interface DragSnapSettings {
  snapEnabled: boolean;
  snapGridSize: number;
}

/** 会话从拖动事件与键盘跟踪得到的修饰键状态（Shift 由适配层换算为轴限） */
export interface DragSnapModifiers {
  bypass: boolean;
  shift: boolean;
}

/** 移动集中的一个节点：基准绝对盒 + 本帧原始（未吸附）世界位移 */
export interface MovingBox {
  bounds: SnapBounds;
  delta: Point;
}

export interface BuildSnapFrameInput {
  moving: readonly MovingBox[];
  targets: readonly SnapTarget[];
  zoom: number;
  settings: DragSnapSettings;
  modifiers: DragSnapModifiers;
  state: SnapSessionState;
}

/** 空移动集的占位盒：零尺寸无法通过 isValidSnapBounds，等价于本次不吸附 */
const EMPTY_MOVING_BOUNDS: SnapBounds = { x: 0, y: 0, width: 0, height: 0 };

/**
 * 节点盒尺寸：显式尺寸优先，其次实测尺寸，最后按默认盒兜底。
 * 规则 2.6 明确吸附沿用本取值链，不改为 tidy-layout 的 measured-first 链。
 */
function nodeBoxSize(node: AnyNode): { width: number; height: number } {
  return {
    width: Number(node.style?.width) || Number(node.measured?.width) || 200,
    height: Number(node.style?.height) || Number(node.measured?.height) || 120,
  };
}

/** 节点的绝对坐标盒；尺寸链无有效值时返回 null（不参与吸附与目标集合） */
export function nodeAbsoluteBounds(
  node: AnyNode,
  nodeById: Map<string, AnyNode>,
): SnapBounds | null {
  const position = nodeAbsolutePosition(node, nodeById);
  const bounds = { ...position, ...nodeBoxSize(node) };
  return isValidSnapBounds(bounds) ? bounds : null;
}

/**
 * 构建候选目标：排除移动集与隐藏节点，保留组框；顺序沿用 store 数组顺序。
 * `movingIds` 是本次拖动的完整移动集（拖动项 + 被拖组的成员）。
 */
export function buildSnapTargets(
  nodes: readonly AnyNode[],
  movingIds: ReadonlySet<string>,
  nodeById: Map<string, AnyNode>,
): SnapTarget[] {
  const targets: SnapTarget[] = [];
  nodes.forEach((node, order) => {
    if (movingIds.has(node.id) || node.hidden === true) return;
    const bounds = nodeAbsoluteBounds(node, nodeById);
    if (bounds) targets.push({ id: node.id, order, bounds });
  });
  return targets;
}

function unionOf(boxes: readonly SnapBounds[]): SnapBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const box of boxes) {
    if (!isValidSnapBounds(box)) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
    count += 1;
  }
  if (count === 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Shift 轴限：以原始帧并集原点相对基准原点的位移判断主导轴 */
function dominantAxis(base: SnapBounds, raw: SnapBounds): SnapAxis {
  const dx = raw.x - base.x;
  const dy = raw.y - base.y;
  return Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
}

/**
 * 构建吸附帧：主体 = 移动集原始盒 + 原始位移的并集；Shift 在此换算为
 * 主导轴限制（规则 8.2）；其余设置原样交给引擎。
 */
export function buildSnapFrame(input: BuildSnapFrameInput): SnapFrame {
  const baseUnion = unionOf(input.moving.map((box) => box.bounds));
  const rawUnion = unionOf(input.moving.map((box) => shiftBounds(box.bounds, box.delta)));
  const lockAxis =
    input.modifiers.shift && baseUnion && rawUnion ? dominantAxis(baseUnion, rawUnion) : null;

  return {
    subject: rawUnion ?? EMPTY_MOVING_BOUNDS,
    targets: input.targets,
    zoom: input.zoom,
    settings: {
      enabled: input.settings.snapEnabled,
      gridSize: input.settings.snapGridSize,
    },
    modifiers: {
      bypass: input.modifiers.bypass,
      lockAxis,
    },
    state: input.state,
  };
}

/**
 * 把世界坐标吸附偏移应用到拖动项的相对位置。
 * 父节点在拖动中静止（或被同偏移移动），因此相对位置与绝对位置共享同一偏移。
 */
export function applySnapOffset(
  rawPositions: ReadonlyMap<string, Point>,
  offset: Point,
): ReadonlyMap<string, Point> {
  if (offset.x === 0 && offset.y === 0) return rawPositions;
  const positions = new Map<string, Point>();
  for (const [id, position] of rawPositions) {
    positions.set(id, { x: position.x + offset.x, y: position.y + offset.y });
  }
  return positions;
}
