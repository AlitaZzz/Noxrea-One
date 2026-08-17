/**
 * 连线流光（流动光点）相关常量与组件。
 * 选中节点时连线、拖拽连接预览线均复用此处，保证视觉一致。
 */
import { useId } from "react";

import { getBezierPath } from "@xyflow/react";

export const DOT_COLOR = "#1D9E75";
export const DURATION = 1.6;
export const STAGGER = [0, -0.55, -1.1];

/**
 * 光点 + 光晕的 SVG 元素组，沿 path 流动。
 * 每对由一个透明光晕 (r=8) 和一个实心内核 (r=3) 组成。
 */
function FlowingDot({ pathId, begin, color }: { pathId: string; begin: number; color: string }) {
  const motionPathHref = `#${pathId}`;

  return (
    <g>
      <circle r="8" fill={`${color}33`}>
        <animateMotion dur={`${DURATION}s`} repeatCount="indefinite" begin={`${begin}s`}>
          <mpath href={motionPathHref} />
        </animateMotion>
      </circle>
      <circle r="3" fill={color}>
        <animateMotion dur={`${DURATION}s`} repeatCount="indefinite" begin={`${begin}s`}>
          <mpath href={motionPathHref} />
        </animateMotion>
      </circle>
    </g>
  );
}

/**
 * 使用稳定的 mpath 引用渲染整组流光。
 * 路径变化时只更新几何形状，不替换 animateMotion 的 path 属性，避免动画时间线重置。
 */
export function FlowingDots({ path, color = DOT_COLOR }: { path: string; color?: string }) {
  const pathId = useId();

  return (
    <>
      <path id={pathId} d={path} fill="none" stroke="none" />
      {STAGGER.map((begin) => (
        <FlowingDot key={begin} pathId={pathId} begin={begin} color={color} />
      ))}
    </>
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
