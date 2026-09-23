/**
 * 删除连线图标（断开的两段线），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function UnlinkIcon({ className, style }: IconProps) {
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
      <path stroke="currentColor" strokeLinecap="round" strokeWidth={1.2} d="M2.5 13.5 5.6 10.4" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth={1.2} d="M10.4 5.6l3.1-3.1" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth={1.2} d="m6.6 6.6 2.8 2.8" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth={1.2} d="M4.6 7.2 3 5.6M8.8 11.4l1.6 1.6" />
    </svg>
  );
}

export default UnlinkIcon;
