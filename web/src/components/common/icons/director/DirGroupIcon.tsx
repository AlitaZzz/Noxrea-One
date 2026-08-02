import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function DirGroupIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="2.1" />
      <circle cx="17" cy="7" r="2.1" />
      <circle cx="7" cy="17" r="2.1" />
      <circle cx="17" cy="17" r="2.1" />
    </svg>
  );
}

export default DirGroupIcon;
