/**
 * 一进两出的链路图标，用于组布局菜单中的智能布局项。
 */
import type { SVGProps } from "react";

export function SmartLayoutIcon({ style, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 19.8 19.8"
      fill="none"
      aria-hidden="true"
      {...props}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
    >
      <path
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        d="M6.6 9.9 13.2 3.3M6.6 9.9l6.6 6.6"
      />
      <rect x="0" y="6.6" width="6.6" height="6.6" rx="1.5" fill="currentColor" />
      <rect x="13.2" y="0" width="6.6" height="6.6" rx="1.5" fill="currentColor" />
      <rect x="13.2" y="13.2" width="6.6" height="6.6" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export default SmartLayoutIcon;
