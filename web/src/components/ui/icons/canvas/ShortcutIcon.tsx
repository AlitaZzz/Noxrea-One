/**
 * 快捷键图标，用于打开快捷键说明弹窗。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

/** 键盘快捷键图标：圆角键盘轮廓 + 键帽 */
export function ShortcutIcon({ className, style }: IconProps) {
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
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6" y2="10" />
      <line x1="9.5" y1="10" x2="9.5" y2="10" />
      <line x1="13" y1="10" x2="13" y2="10" />
      <line x1="16.5" y1="10" x2="16.5" y2="10" />
      <line x1="6" y1="14" x2="6" y2="14" />
      <line x1="9.5" y1="14" x2="9.5" y2="14" />
      <line x1="13" y1="14" x2="13" y2="14" />
      <line x1="18" y1="14" x2="18" y2="14" />
      <line x1="7" y1="18" x2="17" y2="18" />
    </svg>
  );
}

export default ShortcutIcon;
