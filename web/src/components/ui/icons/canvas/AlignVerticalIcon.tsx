/**
 * 垂直布局图标，用于组节点工具条的布局菜单。
 * 采用 lucide 风格（描边），与 canvas 其他图标保持一致。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function AlignVerticalIcon({ className, style }: IconProps) {
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
      <rect x="9" y="3" width="6" height="18" rx="1" />
      <line x1="4" y1="9" x2="4" y2="15" />
      <line x1="20" y1="9" x2="20" y2="15" />
    </svg>
  );
}

export default AlignVerticalIcon;
