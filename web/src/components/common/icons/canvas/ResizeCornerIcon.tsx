/**
 * 节点右下角缩放手柄的视觉图标。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function ResizeCornerIcon({ className, style }: IconProps) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={className}
      style={{ display: "inline-block", opacity: 0.4, pointerEvents: "none", ...style }}
    >
      <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="11" y1="7" x2="7" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="11" y1="11" x2="11" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export default ResizeCornerIcon;
