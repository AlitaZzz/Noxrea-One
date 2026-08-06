/**
 * 节点拖拽对齐辅助线。
 * 把 use-alignment-guides 计算出的画布坐标辅助线换算为屏幕坐标并叠加渲染。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useMemo } from "react";

import { AlignmentGuidesOverlay } from "@/components/ui/icons/canvas/AlignmentGuidesOverlay";
import type { AlignmentGuide } from "@/features/canvas/hooks/use-alignment-guides";

interface Props {
  guides: AlignmentGuide[];
}

/**
 * 对齐辅助线渲染组件。
 *
 * 将画布坐标系下的对齐线数据通过 `flowToScreenPosition` 转换为屏幕坐标，
 * 以半透明蓝色虚线绘制在画布叠加层上。
 */
export default function AlignmentGuides({ guides }: Props) {
  const rf = useReactFlow();

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
    <AlignmentGuidesOverlay>
      {screenLines.map((line) => (
        <line
          key={line.key}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke="#1677ff"
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.7}
          shapeRendering="crispEdges"
        />
      ))}
    </AlignmentGuidesOverlay>
  );
}
