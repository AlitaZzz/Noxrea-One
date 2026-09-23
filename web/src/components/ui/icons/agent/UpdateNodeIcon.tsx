/**
 * 更新节点图标（方框 + 铅笔），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function UpdateNodeIcon({ className, style }: IconProps) {
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
        d="M8 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9"
      />
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.2}
        d="M9.8 10.2 14 6a1.2 1.2 0 0 0-1.7-1.7l-4.2 4.2-.5 2.2z"
      />
    </svg>
  );
}

export default UpdateNodeIcon;
