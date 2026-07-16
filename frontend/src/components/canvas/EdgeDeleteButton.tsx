"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { ScissorOutlined } from "@ant-design/icons";

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
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const onEdgeClick = (evt: React.MouseEvent) => {
    evt.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("canvas:delete-edges", { detail: { edgeIds: [id] } })
    );
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          strokeWidth: selected ? 3 : 2,
          stroke: selected ? "#1677ff" : (style.stroke as string || "var(--canvas-text-muted)"),
        }}
        markerEnd={markerEnd}
      />
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
              width: 22,
              height: 22,
              background: "var(--canvas-bg, #262626)",
              border: "1px solid #555",
              cursor: "pointer",
              opacity: selected ? 1 : 0,
              transition: "opacity 0.15s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            <ScissorOutlined style={{ color: "var(--canvas-text-dim)", fontSize: 12 }} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
