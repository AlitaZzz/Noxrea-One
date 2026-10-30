/**
 * 拖动吸附引擎（纯函数）。
 *
 * 吸附由唯一总开关控制：关闭时对齐与网格都不生效；开启时对齐优先，网格只在
 * 无对齐的轴生效。阈值以屏幕像素定义、按本次拖动开始时的视口缩放换算，进入
 * 5px、保持 8px 形成每轴滞回。辅助线只表达当前偏移下恰好成立的对齐关系。
 * 完整规则见 specs/canvas-snap-alignment.md。
 *
 * 本模块不读写 store / DOM；目标集合与缩放由拖动会话在开始时构建并传入。
 */
import { LAYOUT_GAP } from "@/lib/constants";

import type { AlignmentGuide } from "./alignment-guides";
import { GEOMETRY_EPSILON, type Point, type Rect } from "./geometry";

/** 进入吸附的屏幕像素阈值 */
const SNAP_ENTER_TOLERANCE_PX = 5;
/** 已锁定关系的保持阈值（屏幕像素），必须大于进入阈值 */
const SNAP_RELEASE_TOLERANCE_PX = 8;
/** 网格吸附的最小屏幕像素步长；低于它网格整体关闭 */
const SNAP_GRID_MIN_SCREEN_PX = 8;

export type SnapAxis = "x" | "y";
type SnapAnchor = "start" | "center" | "end";

/** 绝对（世界）坐标下的矩形盒；结构复用共享 Rect，领域命名保持不变。 */
export type SnapBounds = Rect;

/** 吸附目标：绝对盒 + store 顺序（排序并列时使用） */
export interface SnapTarget {
  id: string;
  order: number;
  bounds: SnapBounds;
}

/** 吸附设置：`enabled` 是总开关（规则 1.1），关闭时引擎不产生任何吸附 */
export interface SnapSettings {
  enabled: boolean;
  gridSize: number;
}

export interface SnapModifiers {
  /** Ctrl/Meta：本次拖动完全旁路对齐与网格 */
  bypass: boolean;
  /** Shift：仅该轴参与吸附；null 表示两轴都参与 */
  lockAxis: SnapAxis | null;
}

/**
 * 每轴锁定的关系。isGap 表示边到边间距关系；此时 targetAnchor 记录的是
 * 参与间距计算的边（subject start ↔ target end，或 subject end ↔ target start）。
 */
interface SnapLock {
  targetId: string;
  subjectAnchor: SnapAnchor;
  targetAnchor: SnapAnchor;
  isGap: boolean;
}

export interface SnapSessionState {
  x: SnapLock | null;
  y: SnapLock | null;
}

/** 无锁定的会话状态；工厂函数保证每个调用点拿到独立对象 */
export function emptySnapState(): SnapSessionState {
  return { x: null, y: null };
}

export interface SnapFrame {
  /** 移动集原始几何的并集（未加吸附偏移） */
  subject: SnapBounds;
  targets: readonly SnapTarget[];
  /** 本次拖动开始时的缩放；无效值关闭全部吸附 */
  zoom: number;
  settings: SnapSettings;
  modifiers: SnapModifiers;
  state: SnapSessionState;
}

export interface SnapResolution {
  offset: Point;
  guides: AlignmentGuide[];
  state: SnapSessionState;
}

const AXES: readonly SnapAxis[] = ["x", "y"];
const ANCHORS: readonly SnapAnchor[] = ["start", "center", "end"];
const ANCHOR_RANK: Record<SnapAnchor, number> = { start: 0, center: 1, end: 2 };
const GUIDE_TYPE_RANK: Record<AlignmentGuide["type"], number> = { vertical: 0, horizontal: 1 };

interface SnapRelation extends SnapLock {
  targetOrder: number;
  offset: number;
  targetValue: number;
}

export function isValidSnapBounds(bounds: SnapBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    Number.isFinite(bounds.x + bounds.width) &&
    Number.isFinite(bounds.y + bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

/** 轴上的锚点坐标 */
function snapAnchorValue(bounds: SnapBounds, axis: SnapAxis, anchor: SnapAnchor): number {
  const start = axis === "x" ? bounds.x : bounds.y;
  const size = axis === "x" ? bounds.width : bounds.height;
  if (anchor === "start") return start;
  if (anchor === "center") return start + size / 2;
  return start + size;
}

function crossAxis(axis: SnapAxis): SnapAxis {
  return axis === "x" ? "y" : "x";
}

/** 目标是否可能在任一轴与主体产生对齐（保持阈值 + 间距的保守外扩） */
function isNearSubject(subject: SnapBounds, target: SnapBounds, pad: number): boolean {
  const nearX =
    subject.x - pad <= target.x + target.width && target.x <= subject.x + subject.width + pad;
  const nearY =
    subject.y - pad <= target.y + target.height && target.y <= subject.y + subject.height + pad;
  return nearX || nearY;
}

/** 平移绝对盒（吸附引擎与适配层共用同一实现） */
export function shiftBounds(bounds: SnapBounds, offset: Point): SnapBounds {
  return {
    x: bounds.x + offset.x,
    y: bounds.y + offset.y,
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * 枚举主体与目标在指定轴上的 3×3 锚点对。
 * 吸附选择与辅助线生成共用同一枚举顺序，避免锚点矩阵在两处各写一遍。
 */
function forEachAnchorPair(
  subject: SnapBounds,
  target: SnapBounds,
  axis: SnapAxis,
  visit: (
    subjectAnchor: SnapAnchor,
    targetAnchor: SnapAnchor,
    subjectValue: number,
    targetValue: number,
  ) => void,
): void {
  for (const subjectAnchor of ANCHORS) {
    const subjectValue = snapAnchorValue(subject, axis, subjectAnchor);
    for (const targetAnchor of ANCHORS) {
      visit(subjectAnchor, targetAnchor, subjectValue, snapAnchorValue(target, axis, targetAnchor));
    }
  }
}

function relationTargetValue(
  target: SnapTarget,
  axis: SnapAxis,
  subjectAnchor: SnapAnchor,
  targetAnchor: SnapAnchor,
  isGap: boolean,
): number {
  if (!isGap) return snapAnchorValue(target.bounds, axis, targetAnchor);
  // 间距关系：主体起始边贴目标结束边 + GAP，或主体结束边贴目标起始边 − GAP
  const targetStart = snapAnchorValue(target.bounds, axis, "start");
  const targetEnd = snapAnchorValue(target.bounds, axis, "end");
  return subjectAnchor === "start" ? targetEnd + LAYOUT_GAP : targetStart - LAYOUT_GAP;
}

/** 关系排序：|offset| → 同锚点 → 目标顺序 → 主体锚点 → 目标锚点 */
function compareRelations(a: SnapRelation, b: SnapRelation): number {
  const byOffset = Math.abs(a.offset) - Math.abs(b.offset);
  if (byOffset !== 0) return byOffset;
  const aSame = !a.isGap && a.subjectAnchor === a.targetAnchor;
  const bSame = !b.isGap && b.subjectAnchor === b.targetAnchor;
  if (aSame !== bSame) return aSame ? -1 : 1;
  if (a.targetOrder !== b.targetOrder) return a.targetOrder - b.targetOrder;
  const bySubjectAnchor = ANCHOR_RANK[a.subjectAnchor] - ANCHOR_RANK[b.subjectAnchor];
  if (bySubjectAnchor !== 0) return bySubjectAnchor;
  return ANCHOR_RANK[a.targetAnchor] - ANCHOR_RANK[b.targetAnchor];
}

function lockedRelation(
  subject: SnapBounds,
  targets: readonly SnapTarget[],
  axis: SnapAxis,
  lock: SnapLock,
  release: number,
): SnapRelation | null {
  const target = targets.find((candidate) => candidate.id === lock.targetId);
  if (!target) return null;
  const targetValue = relationTargetValue(
    target,
    axis,
    lock.subjectAnchor,
    lock.targetAnchor,
    lock.isGap,
  );
  const subjectValue = snapAnchorValue(subject, axis, lock.subjectAnchor);
  const offset = targetValue - subjectValue;
  if (Math.abs(offset) > release) return null;
  return {
    targetId: target.id,
    targetOrder: target.order,
    subjectAnchor: lock.subjectAnchor,
    targetAnchor: lock.targetAnchor,
    isGap: lock.isGap,
    offset,
    targetValue,
  };
}

function chooseRelation(
  subject: SnapBounds,
  targets: readonly SnapTarget[],
  axis: SnapAxis,
  enter: number,
  pad: number,
): SnapRelation | null {
  let best: SnapRelation | null = null;
  const consider = (relation: SnapRelation) => {
    if (!best || compareRelations(relation, best) < 0) best = relation;
  };

  for (const target of targets) {
    if (!isNearSubject(subject, target.bounds, pad)) continue;

    forEachAnchorPair(
      subject,
      target.bounds,
      axis,
      (subjectAnchor, targetAnchor, subjectValue, targetValue) => {
        const offset = targetValue - subjectValue;
        if (Math.abs(offset) > enter) return;
        consider({
          targetId: target.id,
          targetOrder: target.order,
          subjectAnchor,
          targetAnchor,
          isGap: false,
          offset,
          targetValue,
        });
      },
    );

    // 边到边间距关系（只吸附，不画线）
    for (const subjectAnchor of ["start", "end"] as const) {
      const targetAnchor = subjectAnchor === "start" ? "end" : "start";
      const targetValue = relationTargetValue(
        target,
        axis,
        subjectAnchor,
        targetAnchor,
        true,
      );
      const subjectValue = snapAnchorValue(subject, axis, subjectAnchor);
      const offset = targetValue - subjectValue;
      if (Math.abs(offset) > enter) continue;
      consider({
        targetId: target.id,
        targetOrder: target.order,
        subjectAnchor,
        targetAnchor,
        isGap: true,
        offset,
        targetValue,
      });
    }
  }

  return best;
}

/** 网格取整的零位移容差：原点已在网格上时只保留浮点残差，按零位移处理 */
const GRID_ZERO_EPSILON = 1e-9;

function gridOffset(origin: number, gridSize: number): number {
  const snapped = Math.round(origin / gridSize) * gridSize;
  if (!Number.isFinite(snapped)) return 0;
  const delta = snapped - origin;
  return Math.abs(delta) < GRID_ZERO_EPSILON ? 0 : delta;
}

function guideSpan(
  movedSubject: SnapBounds,
  target: SnapBounds,
  axis: SnapAxis,
  subjectAnchor: SnapAnchor,
  targetAnchor: SnapAnchor,
): [number, number] {
  const cross = crossAxis(axis);
  if (subjectAnchor === "center" && targetAnchor === "center") {
    const subjectCenter = snapAnchorValue(movedSubject, cross, "center");
    const targetCenter = snapAnchorValue(target, cross, "center");
    return [Math.min(subjectCenter, targetCenter), Math.max(subjectCenter, targetCenter)];
  }

  const subjectStart = snapAnchorValue(movedSubject, cross, "start");
  const subjectEnd = snapAnchorValue(movedSubject, cross, "end");
  const targetStart = snapAnchorValue(target, cross, "start");
  const targetEnd = snapAnchorValue(target, cross, "end");
  if (subjectStart > targetEnd + GEOMETRY_EPSILON) return [targetEnd, subjectStart];
  if (targetStart > subjectEnd + GEOMETRY_EPSILON) return [subjectEnd, targetStart];
  return [Math.min(subjectStart, targetStart), Math.max(subjectEnd, targetEnd)];
}

function buildGuides(
  subject: SnapBounds,
  targets: readonly SnapTarget[],
  offset: Point,
  aligned: Record<SnapAxis, boolean>,
  pad: number,
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  const movedSubject = shiftBounds(subject, offset);

  for (const axis of AXES) {
    if (!aligned[axis]) continue;
    for (const target of targets) {
      if (!isNearSubject(subject, target.bounds, pad)) continue;
      forEachAnchorPair(
        movedSubject,
        target.bounds,
        axis,
        (subjectAnchor, targetAnchor, subjectValue, targetValue) => {
          if (Math.abs(subjectValue - targetValue) > GEOMETRY_EPSILON) return;
          const [start, end] = guideSpan(
            movedSubject,
            target.bounds,
            axis,
            subjectAnchor,
            targetAnchor,
          );
          guides.push({
            type: axis === "x" ? "vertical" : "horizontal",
            position: targetValue,
            start,
            end,
          });
        },
      );
    }
  }

  return mergeGuides(guides);
}

/** 同轴同坐标且跨度重叠的线段合并；同坐标不相交的线段保留多条 */
function mergeGuides(guides: AlignmentGuide[]): AlignmentGuide[] {
  const merged: AlignmentGuide[] = [];
  for (const guide of guides) {
    let current = guide;
    let index = 0;
    while (index < merged.length) {
      const other = merged[index];
      const sameLine =
        other.type === current.type &&
        Math.abs(other.position - current.position) <= GEOMETRY_EPSILON;
      const overlaps =
        other.start <= current.end + GEOMETRY_EPSILON && current.start <= other.end + GEOMETRY_EPSILON;
      if (sameLine && overlaps) {
        current = {
          type: current.type,
          position: current.position,
          start: Math.min(other.start, current.start),
          end: Math.max(other.end, current.end),
        };
        merged.splice(index, 1);
        index = 0;
      } else {
        index += 1;
      }
    }
    merged.push(current);
  }

  merged.sort(
    (a, b) =>
      GUIDE_TYPE_RANK[a.type] - GUIDE_TYPE_RANK[b.type] ||
      a.position - b.position ||
      a.start - b.start ||
      a.end - b.end,
  );
  return merged;
}

/**
 * 解析一帧吸附：返回两轴偏移、新的每轴锁定状态与辅助线。
 * 总开关关闭时直接返回零偏移、无辅助线与空锁定（规则 1.1）；开启时锁定关系
 * 优先，失锁后按进入阈值重新选择，无对齐的轴可网格取整。
 */
export function resolveSnap(frame: SnapFrame): SnapResolution {
  const { subject, targets, zoom, settings, modifiers } = frame;
  if (!settings.enabled || !Number.isFinite(zoom) || zoom <= 0 || !isValidSnapBounds(subject)) {
    return { offset: { x: 0, y: 0 }, guides: [], state: emptySnapState() };
  }

  const enter = SNAP_ENTER_TOLERANCE_PX / zoom;
  const release = SNAP_RELEASE_TOLERANCE_PX / zoom;
  const pad = release + LAYOUT_GAP;
  const gridSize = settings.gridSize;
  const gridEnabled =
    Number.isFinite(gridSize) && gridSize > 0 && gridSize * zoom >= SNAP_GRID_MIN_SCREEN_PX;

  const offset = { x: 0, y: 0 };
  const aligned: Record<SnapAxis, boolean> = { x: false, y: false };
  const state = emptySnapState();

  for (const axis of AXES) {
    const axisEnabled =
      !modifiers.bypass && (modifiers.lockAxis === null || modifiers.lockAxis === axis);
    if (!axisEnabled) continue;

    const previous = frame.state[axis];
    const relation =
      (previous ? lockedRelation(subject, targets, axis, previous, release) : null) ??
      chooseRelation(subject, targets, axis, enter, pad);

    if (relation) {
      offset[axis] = relation.offset;
      aligned[axis] = true;
      state[axis] = {
        targetId: relation.targetId,
        subjectAnchor: relation.subjectAnchor,
        targetAnchor: relation.targetAnchor,
        isGap: relation.isGap,
      };
      continue;
    }

    if (gridEnabled) {
      // 网格按并集左上角取整（规则 6.2），轴翻转统一走锚点取值
      offset[axis] = gridOffset(snapAnchorValue(subject, axis, "start"), gridSize);
    }
  }

  return {
    offset,
    guides: buildGuides(subject, targets, offset, aligned, pad),
    state,
  };
}
