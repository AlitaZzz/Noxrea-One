/**
 * 新建会话图标，用于对话面板新开一轮对话。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function NewChatIcon({ className, style }: IconProps) {
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
        d="M14.667 11.333a1.333 1.333 0 0 1-1.334 1.334H4.552c-.354 0-.693.14-.943.39l-1.468 1.468a.473.473 0 0 1-.808-.334V3.333A1.333 1.333 0 0 1 2.667 2h10.666a1.333 1.333 0 0 1 1.334 1.333z"
      />
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={0.8}
        d="M5.333 7.333h5.334M8 4.667V10"
      />
    </svg>
  );
}

export default NewChatIcon;
