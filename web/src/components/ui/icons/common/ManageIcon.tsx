/**
 * 管理（三行滑块）图标，用于资产库工具条进入多选 / 批量管理模式。
 * 尺寸由父级容器通过 font-size 控制（1em），颜色走 currentColor。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function ManageIcon({ className, style }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", flexShrink: 0, ...style }}
    >
      <path d="M4 7h4.5" />
      <path d="M13.5 7H20" />
      <circle cx="11" cy="7" r="2.1" />
      <path d="M4 12h8.5" />
      <path d="M17.5 12H20" />
      <circle cx="15" cy="12" r="2.1" />
      <path d="M4 17h2.5" />
      <path d="M11.5 17H20" />
      <circle cx="9" cy="17" r="2.1" />
    </svg>
  );
}

export default ManageIcon;
