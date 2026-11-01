/**
 * 连线的纯几何（全库唯一实现）。
 *
 * 连线端点恒落在节点边缘垂直正中：xyflow 给出的坐标在轨道上，按方位收回轨道宽
 * 即达节点边缘（见 constants.ts 的注释）。`DeletableEdge` 渲染与拖动预览会话的
 * 路径重算必须共用本函数，保证拖动期预览与提交后的静态几何逐像素一致
 * （specs/canvas-drag-preview-session.md 规则 4.3）。
 *
 * 返回值同时给出三次贝塞尔控制点与弧长：画布流光层按控制点描边、按弧长归一化
 * 流光长度（specs/canvas-flow-layer.md 规则 1）。控制点计算与 @xyflow/system 的
 * `getBezierPath` 同一公式（曲率默认 0.25），由单元测试逐字节对比路径字符串锁定。
 */
import { getBezierEdgeCenter, Position } from "@xyflow/react";

import { insetEdgeAnchor } from "@/lib/constants";

/** 连线端点在轨道上的原始几何（xyflow 坐标，未收回轨道宽） */
export interface EdgeEndpointGeometry {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}

export interface EdgePoint {
  x: number;
  y: number;
}

/** 三次贝塞尔：起点、两个控制点、终点（流坐标） */
export interface BezierCurve {
  start: EdgePoint;
  control1: EdgePoint;
  control2: EdgePoint;
  end: EdgePoint;
}

export interface EdgePathGeometry {
  path: string;
  labelX: number;
  labelY: number;
  curve: BezierCurve;
  /** 路径弧长（流坐标单位）：流光按它把「每段占路径固定比例」换算成画布长度 */
  length: number;
}

/** 与 `getBezierPath` 的默认曲率一致 */
const CURVATURE = 0.25;

/** 弧长逼近的分段数：强弯曲路径（反向控制点）下相对误差仍 < 0.5% */
const LENGTH_SAMPLES = 32;

/** 控制点离端点的距离（与 @xyflow/system `calculateControlOffset` 同一公式） */
function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

/** 端点方位 → 控制点（与 @xyflow/system `getControlWithCurvature` 同一公式） */
function controlPoint(position: Position, from: EdgePoint, to: EdgePoint): EdgePoint {
  switch (position) {
    case Position.Left:
      return { x: from.x - controlOffset(from.x - to.x), y: from.y };
    case Position.Right:
      return { x: from.x + controlOffset(to.x - from.x), y: from.y };
    case Position.Top:
      return { x: from.x, y: from.y - controlOffset(from.y - to.y) };
    case Position.Bottom:
      return { x: from.x, y: from.y + controlOffset(to.y - from.y) };
  }
}

/** 三次贝塞尔弧长（折线逼近） */
export function cubicLength(curve: BezierCurve): number {
  const { start, control1, control2, end } = curve;
  let length = 0;
  let prevX = start.x;
  let prevY = start.y;
  for (let i = 1; i <= LENGTH_SAMPLES; i++) {
    const t = i / LENGTH_SAMPLES;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    const x = a * start.x + b * control1.x + c * control2.x + d * end.x;
    const y = a * start.y + b * control1.y + c * control2.y + d * end.y;
    length += Math.hypot(x - prevX, y - prevY);
    prevX = x;
    prevY = y;
  }
  return length;
}

/** 由端点几何计算贝塞尔路径、标签锚点、控制点与弧长（收回轨道宽后） */
export function computeEdgePath(geometry: EdgeEndpointGeometry): EdgePathGeometry {
  const start = insetEdgeAnchor(geometry.sourcePosition, geometry.sourceX, geometry.sourceY);
  const end = insetEdgeAnchor(geometry.targetPosition, geometry.targetX, geometry.targetY);
  const control1 = controlPoint(geometry.sourcePosition, start, end);
  const control2 = controlPoint(geometry.targetPosition, end, start);
  const [labelX, labelY] = getBezierEdgeCenter({
    sourceX: start.x,
    sourceY: start.y,
    targetX: end.x,
    targetY: end.y,
    sourceControlX: control1.x,
    sourceControlY: control1.y,
    targetControlX: control2.x,
    targetControlY: control2.y,
  });
  const curve: BezierCurve = { start, control1, control2, end };
  return {
    path: `M${start.x},${start.y} C${control1.x},${control1.y} ${control2.x},${control2.y} ${end.x},${end.y}`,
    labelX,
    labelY,
    curve,
    length: cubicLength(curve),
  };
}
