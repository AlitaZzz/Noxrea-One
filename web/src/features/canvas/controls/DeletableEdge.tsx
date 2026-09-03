/**
 * 自定义连线组件（贝塞尔曲线）。
 * 生成连线会渲染管道流光动画。删除连线使用键盘 Delete 键（见 use-canvas-keyboard）。
 */
"use client";

import { BaseEdge, type EdgeProps,getBezierPath } from "@xyflow/react";

import { useHighlightedEdges } from "@/providers/edge-highlight-context";
import { EDGE_BASE_COLOR, insetEdgeAnchor } from "@/lib/constants";

import { DOT_COLOR, FlowLines } from "./EdgeFlow";

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
          strokeWidth: isConnected ? 2.5 : 2,
          // 底线恒为中性灰（选中时提亮一档），彩色只留给流光：
          // 两者同色会糊成一片，流光的水滴形状就看不见了
          stroke: isConnected ? "var(--canvas-text-dim)" : (style.stroke as string || EDGE_BASE_COLOR),
        }}
      />

      {/* 管道流光（选中节点或边时叠加） */}
      {isConnected && <FlowLines path={edgePath} color={DOT_COLOR} />}
    </>
  );
}