/**
 * 垂直布局图标，用于组布局菜单中的垂直布局项。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function VerticalLayoutIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        transform="translate(0 2.4472) scale(0.828157)"
        d="M.81 11.81a.8.8 0 0 1 0 1.6H.8a.8.8 0 1 1 0-1.6zm17.71 0a.8.8 0 0 1 0 1.6H5.72a.8.8 0 1 1 0-1.6zM.81 5.91a.8.8 0 0 1 0 1.6H.8a.8.8 0 0 1 0-1.6zm17.71 0a.8.8 0 0 1 0 1.6H5.72a.8.8 0 0 1 0-1.6zM.81 0a.8.8 0 1 1 0 1.6H.8A.8.8 0 1 1 .8 0zm17.71 0a.8.8 0 1 1 0 1.6H5.72a.8.8 0 1 1 0-1.6z"
      />
    </svg>
  );
}

export default VerticalLayoutIcon;
