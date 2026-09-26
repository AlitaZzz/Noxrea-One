/**
 * 光源矫正图标，用于「创作」菜单中的「电影级光影校正」项。
 * 半明半暗圆形（contrast）造型，代表明暗光比的校正。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function LightCorrectionIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", ...style }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 18a6 6 0 0 0 0-12v12z" />
    </svg>
  );
}

export default LightCorrectionIcon;
