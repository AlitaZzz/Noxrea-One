/**
 * 文本图标，代表文本类型节点。
 */
"use client";

import type { CSSProperties } from "react";

interface TextIconProps {
  className?: string;
  style?: CSSProperties;
}

/**
 * 统一文本节点图标（4 条横线，上短下长）。
 * 使用 1em 尺寸，继承父元素 font-size，与 antd 图标行为一致。
 */
export function TextIcon({ className, style }: TextIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      style={{ display: "inline-block", width: "1em", height: "1em", verticalAlign: "-0.125em", ...style }}
    >
      <g transform="translate(1 0.5)">
        <path d="M9.33 14.62H0v-2.1h9.33zM14 10.44H0v-2.1h14zm0-4.17H0v-2.1h14zm0-4.17H0V0h14z" fill="currentColor" />
      </g>
    </svg>
  );
}

export default TextIcon;
