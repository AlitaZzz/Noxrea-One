/**
 * 磁吸图标，用于画布控制条的对齐吸附开关。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function MagnetIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      {/* 马蹄磁铁 */}
      <path d="M5 16V10a7 7 0 0 1 14 0v6" />
      {/* 两极 */}
      <rect x="3.5" y="13.5" width="5" height="4" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="15.5" y="13.5" width="5" height="4" rx="1.2" fill="currentColor" stroke="none" />
      {/* 被吸附的节点 */}
      <circle cx="12" cy="20" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="20" r="1" fill="currentColor" stroke="none" opacity="0.45" />
      <circle cx="17.5" cy="20" r="1" fill="currentColor" stroke="none" opacity="0.45" />
    </svg>
  );
}

export default MagnetIcon;
