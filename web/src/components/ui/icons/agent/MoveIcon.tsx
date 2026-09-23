/**
 * 移动节点图标（四向箭头），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function MoveIcon({ className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", ...style }}
    >
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.2}
        d="M8 2.5v11M2.5 8h11"
      />
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.2}
        d="m5.9 4.6 2.1-2.1 2.1 2.1M5.9 11.4l2.1 2.1 2.1-2.1M4.6 5.9 2.5 8l2.1 2.1M11.4 5.9 13.5 8l-2.1 2.1"
      />
    </svg>
  );
}

export default MoveIcon;
