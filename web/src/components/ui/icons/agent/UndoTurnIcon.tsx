/**
 * 回合撤销图标（逆时针回转箭头），用于聊天面板「撤销此轮」按钮。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function UndoTurnIcon({ className, style }: IconProps) {
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
        d="M3 3.2v3.3h3.3"
      />
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.2}
        d="M3.6 10a5.2 5.2 0 1 0 .6-4.6L3 6.5"
      />
    </svg>
  );
}

export default UndoTurnIcon;
