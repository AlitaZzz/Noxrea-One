import type { ReactNode, CSSProperties } from "react";

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
