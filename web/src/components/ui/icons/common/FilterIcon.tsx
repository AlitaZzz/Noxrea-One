/**
 * 筛选（三条水平线）图标，用于资产库工具条的筛选按钮。
 * 尺寸由父级容器通过 font-size 控制（1em），颜色走 currentColor。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function FilterIcon({ className, style }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", flexShrink: 0, ...style }}
    >
      <path
        d="M8.17 9.97a.53.53 0 0 1 0 1.06H5.83a.53.53 0 0 1 0-1.06zm1.75-3.5a.53.53 0 0 1 0 1.06H4.08a.53.53 0 0 1 0-1.06zm2.33-3.5a.53.53 0 0 1 0 1.06H1.75a.53.53 0 0 1 0-1.06z"
        fill="currentColor"
        transform="translate(1 1)"
      />
    </svg>
  );
}

export default FilterIcon;