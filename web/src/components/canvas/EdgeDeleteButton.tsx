"use client";

import { ScissorOutlined } from "@ant-design/icons";
import { BaseEdge, EdgeLabelRenderer, type EdgeProps,getBezierPath } from "@xyflow/react";

import { useHighlightedEdges } from "@/contexts/edge-highlight-context";
import { EventNames } from "@/lib/constants";

const DOT_COLOR = "#1D9E75";
const DURATION = 1.6;
const STAGGER = [0, -0.55, -1.1];

/**
 * 光点 + 光晕的 SVG 元素组，沿 path 流动。
 * 每对由一个透明光晕 (r=8) 和一个实心内核 (r=3) 组成。
 */
function FlowingDot({ path, begin, color }: { path: string; begin: number; color: string }) {
  return (
    <g>
      <circle r="8" fill={`${color}33`}>
        <animateMotion path={path} dur={`${DURATION}s`} repeatCount="indefinite" begin={`${begin}s`} />
      </circle>
      <circle r="3" fill={color}>
        <animateMotion path={path} dur={`${DURATION}s`} repeatCount="indefinite" begin={`${begin}s`} />
      </circle>
    </g>
  );
}

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

      {/* Multi-dot flow animation (when connected node is selected) */}
      {isHighlighted && STAGGER.map((begin) => (
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
