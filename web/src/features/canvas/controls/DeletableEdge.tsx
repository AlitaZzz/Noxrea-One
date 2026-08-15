/**
 * 自定义连线组件（贝塞尔曲线）。
 * 生成连线会渲染流动光点动画。删除连线使用键盘 Delete 键（见 use-canvas-keyboard）。
 */
"use client";

import { BaseEdge, type EdgeProps,getBezierPath } from "@xyflow/react";

import { useHighlightedEdges } from "@/providers/edge-highlight-context";

import { DOT_COLOR, FlowingDot, STAGGER } from "./EdgeFlow";

export default function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  style = {},
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const highlightedEdgeIds = useHighlightedEdges();
  const isHighlighted = highlightedEdgeIds.has(id);
  // 选中节点关联的边高亮：由组件自身按 Context 判断，避免父级逐边重建全部边对象
  const isConnected = isHighlighted || selected;

  return (
    <>
      {/* Base path */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          strokeWidth: isConnected ? 3 : 2,
          stroke: isConnected ? "#1D9E75" : (style.stroke as string || "var(--canvas-text-muted)"),
        }}
        markerEnd={markerEnd}
      />

      {/* Multi-dot flow animation (when connected node selected or edge selected) */}
      {isConnected && STAGGER.map((begin) => (
        <FlowingDot key={`${id}-${begin}`} path={edgePath} begin={begin} color={DOT_COLOR} />
      ))}
    </>
  );
}