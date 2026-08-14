/**
 * 4 宫格图标（2×2 + 加号），用于节点工具条的多视角截图操作。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function Grid4Icon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <path fill="currentColor" d="m13.78 10.698-2.12 3.096-.184-.344h3.776v.832h-4.504v-.664l2.704-3.928h1.008v5.656h-.976v-4.72zM12 1.5A2.5 2.5 0 0 1 14.5 4v4a.5.5 0 0 1-.5.5H8.495v5h.832a.5.5 0 0 1 0 1H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5zM2.5 12A1.5 1.5 0 0 0 4 13.5h3.495v-5H2.5zm5.995-4.5H13.5V4A1.5 1.5 0 0 0 12 2.5H8.495zM4 2.5A1.5 1.5 0 0 0 2.5 4v3.5h4.995v-5z" />
    </svg>
  );
}

export default Grid4Icon;