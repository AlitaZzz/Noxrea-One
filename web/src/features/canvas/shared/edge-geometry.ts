/**
 * 连线的纯几何（全库唯一实现）。
 *
 * 连线端点恒落在节点边缘垂直正中：xyflow 给出的坐标在轨道上，按方位收回轨道宽
 * 即达节点边缘（见 constants.ts 的注释）。`DeletableEdge` 渲染与拖动预览会话的
 * 路径重算必须共用本函数，保证拖动期预览与提交后的静态几何逐像素一致
 * （specs/canvas-drag-preview-session.md 规则 4.3）。
 */
import { getBezierPath, type Position } from "@xyflow/react";

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

export interface EdgePathGeometry {
  path: string;
  labelX: number;
  labelY: number;
}

/** 由端点几何计算贝塞尔路径与标签锚点（收回轨道宽后） */
export function computeEdgePath(geometry: EdgeEndpointGeometry): EdgePathGeometry {
  const source = insetEdgeAnchor(geometry.sourcePosition, geometry.sourceX, geometry.sourceY);
  const target = insetEdgeAnchor(geometry.targetPosition, geometry.targetX, geometry.targetY);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: geometry.sourcePosition,
    targetX: target.x,
    targetY: target.y,
    targetPosition: geometry.targetPosition,
  });
  return { path, labelX, labelY };
}
