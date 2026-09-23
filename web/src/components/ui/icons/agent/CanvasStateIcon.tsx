/**
 * 查看画布状态图标（文档 + 折角），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function CanvasStateIcon({ className, style }: IconProps) {
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
        d="M4 2h5.5L13 5.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"
      />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2} d="M9.5 2v3.5H13" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth={1.2} d="M5.5 8.5h5M5.5 11h3.5" />
    </svg>
  );
}

export default CanvasStateIcon;
