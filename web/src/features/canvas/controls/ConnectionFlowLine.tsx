/**
 * 拖拽连接时的自定义预览线组件。
 * 渲染一条绿色贝塞尔预览线，并叠加与「选中节点时连线」一致的绿色流动光点动画。
 */
"use client";

import { BaseEdge, type ConnectionLineComponentProps,getBezierPath, Position } from "@xyflow/react";

import { DOT_COLOR, FlowingDot, STAGGER } from "./EdgeFlow";

export default function ConnectionFlowLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
}: ConnectionLineComponentProps) {
  const [edgePath] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition ?? (fromPosition === Position.Right ? Position.Left : Position.Right),
  });

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: DOT_COLOR, strokeWidth: 2 }} />
      {STAGGER.map((begin) => (
        <FlowingDot key={begin} path={edgePath} begin={begin} color={DOT_COLOR} />
      ))}
    </>
  );
}
