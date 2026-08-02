import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function DirMoveIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <path d="M12 3v18M3 12h18" />
      <path d="M12 3l-2.4 2.6M12 3l2.4 2.6M12 21l-2.4-2.6M12 21l2.4-2.6M3 12l2.6-2.4M3 12l2.6-2.4M21 12l-2.6-2.4M21 12l-2.6-2.4" />
    </svg>
  );
}

export default DirMoveIcon;
