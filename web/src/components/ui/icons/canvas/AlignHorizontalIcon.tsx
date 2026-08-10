/**
 * 水平布局图标，用于组节点工具条的布局菜单。
 * 采用 lucide 风格（描边），与 canvas 其他图标保持一致。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function AlignHorizontalIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <rect x="3" y="9" width="18" height="6" rx="1" />
      <line x1="9" y1="4" x2="15" y2="4" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </svg>
  );
}

export default AlignHorizontalIcon;
