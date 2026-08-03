import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function PlayIcon({ className, style }: IconProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", ...style }}
    >
      <path d="M4.67 2.64a1 1 0 0 1 1.59-.8l7.3 5.36a1 1 0 0 1 0 1.6l-7.3 5.37a1 1 0 0 1-1.6-.8z" />
    </svg>
  );
}

export default PlayIcon;
