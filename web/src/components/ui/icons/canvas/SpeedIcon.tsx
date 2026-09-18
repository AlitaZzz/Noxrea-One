/**
 * 变速图标（速率表盘），用于音频节点工具栏的变速入口。
 * 用户提供的 16×16 填充矢量，fill 改为 currentColor 以跟随主题。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function SpeedIcon({ className, style }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      className={className}
      style={{ display: "inline-block", flexShrink: 0, ...style }}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="currentColor"
        d="M7 .6a.58.58 0 0 1 0 1.16 5.25 5.25 0 1 0 4.99 6.86 5 5 0 0 0-.93-4.86L8.58 6.25A1.74 1.74 0 0 1 7 8.75a1.75 1.75 0 1 1 .75-3.33l2.92-2.92.04-.03a.6.6 0 0 1 .79.03 6.2 6.2 0 0 1 1.6 6.48A6.42 6.42 0 1 1 7 .6m0 5.82a.58.58 0 1 0 .46.23l-.1-.11A.6.6 0 0 0 7 6.42"
        transform="translate(1 1)"
      />
    </svg>
  );
}

export default SpeedIcon;
