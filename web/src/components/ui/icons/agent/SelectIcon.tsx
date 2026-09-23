/**
 * 选中节点图标（虚线框 + 光标），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function SelectIcon({ className, style }: IconProps) {
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
        strokeDasharray="2 1.7"
        d="M10.5 2.5h2a1 1 0 0 1 1 1v2M2.5 5.5v-2a1 1 0 0 1 1-1h2"
      />
      <path
        fill="currentColor"
        stroke="none"
        d="m7.5 7.5 6.3 2.5-2.7 1-1 2.7z"
      />
    </svg>
  );
}

export default SelectIcon;
