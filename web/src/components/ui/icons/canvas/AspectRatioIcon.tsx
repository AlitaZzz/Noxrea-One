/**
 * 画面比例图标，用于节点工具条的截图画幅比例选择。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function AspectRatioIcon({ className, style }: IconProps) {
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
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M7 12.5V11a1 1 0 0 1 1-1h1.5" />
      <path d="M17 11.5V13a1 1 0 0 1-1 1h-1.5" />
    </svg>
  );
}

export default AspectRatioIcon;