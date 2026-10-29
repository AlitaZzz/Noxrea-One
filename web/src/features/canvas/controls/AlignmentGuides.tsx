/**
 * 节点拖拽对齐辅助线。
 * 订阅拖动预览会话发布的画布坐标辅助线，换算为屏幕坐标后叠加渲染。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useMemo, useSyncExternalStore } from "react";

import { getPreviewGuides, subscribePreviewGuides } from "@/features/canvas/drag/preview-guides";

/**
 * 对齐辅助线渲染组件。
 *
 * 辅助线是拖动期的瞬态量：不经 props、不进 store，直接订阅预览会话的发布通道，
 * 画布外壳与节点树不随辅助线变化重渲染（规则 3.3）。将画布坐标系下的对齐线
 * 数据通过 `flowToScreenPosition` 转换为屏幕坐标，以半透明绿色虚线绘制。
 */
export default function AlignmentGuides() {
  const rf = useReactFlow();
  const guides = useSyncExternalStore(subscribePreviewGuides, getPreviewGuides, getPreviewGuides);

  // 将画布坐标转换为屏幕坐标
  const screenLines = useMemo(() => {
    if (guides.length === 0) return [];
    return guides.map((g) => {
      if (g.type === "vertical") {
        const start = rf.flowToScreenPosition({ x: g.position, y: g.start });
        const end = rf.flowToScreenPosition({ x: g.position, y: g.end });
        return { x1: start.x, y1: start.y, x2: end.x, y2: end.y, key: `v-${g.position.toFixed(1)}` };
      } else {
        const start = rf.flowToScreenPosition({ x: g.start, y: g.position });
        const end = rf.flowToScreenPosition({ x: g.end, y: g.position });
        return { x1: start.x, y1: start.y, x2: end.x, y2: end.y, key: `h-${g.position.toFixed(1)}` };
      }
    });
  }, [guides, rf]);

  if (guides.length === 0) return null;

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 100,
        overflow: "visible",
      }}
    >
      {screenLines.map((line) => (
        <line
          key={line.key}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke="rgb(29, 158, 117)"
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.7}
          shapeRendering="crispEdges"
        />
      ))}
    </svg>
  );
}
