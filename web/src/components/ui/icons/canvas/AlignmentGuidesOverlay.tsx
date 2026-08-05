/**
 * 对齐参考线的 SVG 覆盖层容器，承载动态生成的参考线，自身不做计算。
 */
import type { CSSProperties,ReactNode } from "react";

interface OverlayProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * 对齐参考线覆盖层容器（SVG 承载动态 line）。
 * 抽离自 AlignmentGuides，保持原样式与 pointer-events 行为。
 */
export function AlignmentGuidesOverlay({ children, className, style }: OverlayProps) {
  return (
    <svg
      className={className ?? "alignment-guides-overlay"}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 100,
        overflow: "visible",
        ...style,
      }}
    >
      {children}
    </svg>
  );
}

export default AlignmentGuidesOverlay;
