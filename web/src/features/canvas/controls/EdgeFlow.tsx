/**
 * 连线流光（流动光点）相关常量与组件。
 * 选中节点时连线、拖拽连接预览线均复用此处，保证视觉一致。
 */
import { getBezierPath } from "@xyflow/react";

export const DOT_COLOR = "#1D9E75";
export const DURATION = 1.6;
export const STAGGER = [0, -0.55, -1.1];

/**
 * 光点 + 光晕的 SVG 元素组，沿 path 流动。
 * 每对由一个透明光晕 (r=8) 和一个实心内核 (r=3) 组成。
 */
export function FlowingDot({ path, begin, color }: { path: string; begin: number; color: string }) {
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

/** 根据起止坐标计算贝塞尔路径，供流光光点沿路径运动使用。 */
export function useEdgePath(points: {
  sourceX: number;
  sourceY: number;
  sourcePosition: import("@xyflow/react").Position;
  targetX: number;
  targetY: number;
  targetPosition: import("@xyflow/react").Position;
}) {
  return getBezierPath(points);
}
