/**
 * 拖拽连接时的自定义预览线组件。
 * 渲染一条绿色贝塞尔预览线，并叠加与「选中节点时连线」一致的绿色流动光点动画。
 */
"use client";

import { BaseEdge, type ConnectionLineComponentProps,getBezierPath, Position } from "@xyflow/react";

import { insetHandleCenter } from "@/lib/constants";

import { DOT_COLOR, FlowingDots } from "./EdgeFlow";

export default function ConnectionFlowLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
}: ConnectionLineComponentProps) {
  // 起点为源 handle 中心，收回节点边缘；
  // 终点：吸附到目标 handle 时（connectionStatus === 'valid'）toX/toY 为 handle 中心，同样收回贴到节点边缘；
  // 否则是鼠标实时位置，保持不动
  const source = insetHandleCenter(fromPosition, fromX, fromY);
  const target = connectionStatus === "valid" ? insetHandleCenter(toPosition ?? undefined, toX, toY) : { x: toX, y: toY };

  const [edgePath] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: fromPosition,
    targetX: target.x,
    targetY: target.y,
    targetPosition: toPosition ?? (fromPosition === Position.Right ? Position.Left : Position.Right),
  });

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: DOT_COLOR, strokeWidth: 2 }} />
      <FlowingDots path={edgePath} color={DOT_COLOR} />
    </>
  );
}
