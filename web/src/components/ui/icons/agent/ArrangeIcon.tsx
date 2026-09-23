/**
 * 整理画布图标（2×2 点阵），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function ArrangeIcon({ className, style }: IconProps) {
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
        strokeLinejoin="round"
        strokeWidth={1.2}
        d="M3 3h3.4v3.4H3zM9.6 3H13v3.4H9.6zM3 9.6h3.4V13H3zM9.6 9.6H13V13H9.6z"
      />
    </svg>
  );
}

export default ArrangeIcon;
