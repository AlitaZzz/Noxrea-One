/**
 * 自定义连线组件（贝塞尔曲线）。
 * 悬停 / 选中时在中点显示剪断按钮以删除连线，参与生成的连线会渲染流动光点动画。
 */
"use client";

import { ScissorOutlined } from "@ant-design/icons";
import { BaseEdge, EdgeLabelRenderer, type EdgeProps,getBezierPath } from "@xyflow/react";

import { EventNames } from "@/lib/constants";
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
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const highlightedEdgeIds = useHighlightedEdges();
  const isHighlighted = highlightedEdgeIds.has(id);

  const onEdgeClick = (evt: React.MouseEvent) => {
    evt.stopPropagation();
    window.dispatchEvent(
      new CustomEvent(EventNames.CANVAS_DELETE_EDGES, { detail: { edgeIds: [id] } })
    );
  };

  return (
    <>
      {/* Base path */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          strokeWidth: selected ? 3 : 2,
          stroke: selected ? "#1D9E75" : (style.stroke as string || "var(--canvas-text-muted)"),
        }}
        markerEnd={markerEnd}
      />

      {/* Multi-dot flow animation (when connected node selected or edge selected) */}
      {(isHighlighted || selected) && STAGGER.map((begin) => (
        <FlowingDot key={`${id}-${begin}`} path={edgePath} begin={begin} color={DOT_COLOR} />
      ))}

      {/* Delete button */}
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: selected ? "all" : "none",
          }}
        >
          <button
            onClick={onEdgeClick}
            className="nodrag nopan flex items-center justify-center rounded-full"
            style={{
              width: 30,
              height: 30,
              background: "var(--canvas-bg, #262626)",
              border: "1px solid var(--canvas-border)",
              cursor: "pointer",
              opacity: selected ? 1 : 0,
              transition: "opacity 0.15s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            <ScissorOutlined style={{ color: "var(--canvas-text-dim)", fontSize: 16 }} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
