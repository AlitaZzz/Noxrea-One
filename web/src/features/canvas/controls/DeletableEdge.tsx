/**
 * 自定义连线组件（贝塞尔曲线）。
 * 生成连线会渲染流动光点动画。删除连线使用键盘 Delete 键（见 use-canvas-keyboard）。
 */
"use client";

import { BaseEdge, type EdgeProps,getBezierPath } from "@xyflow/react";

import { useHighlightedEdges } from "@/providers/edge-highlight-context";
import { insetEdgeAnchor } from "@/lib/constants";

import { DOT_COLOR, FlowingDots } from "./EdgeFlow";

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
  // handle 按钮悬浮在节点外侧，连线端点取 handle 中心会悬空；
  // 把两端端点收回节点边缘，使线从节点到节点连接
  const source = insetEdgeAnchor(sourcePosition, sourceX, sourceY);
  const target = insetEdgeAnchor(targetPosition, targetX, targetY);

  const [edgePath] = getBezierPath({
    sourceX: source.x, sourceY: source.y, sourcePosition,
    targetX: target.x, targetY: target.y, targetPosition,
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
      {isConnected && <FlowingDots path={edgePath} color={DOT_COLOR} />}
    </>
  );
}