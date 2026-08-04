import type { CSSProperties } from "react";

interface WaveIconProps {
  className?: string;
  style?: CSSProperties;
}

/** 音频波形图标（自定义 SVG path），用法与 antd 图标一致：用 fontSize 控制尺寸 */
export function WaveIcon({ className, style }: WaveIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M1.333 6.667v2M4 4v7.333M6.667 2v12M9.333 5.333V10M12 3.333V12M14.667 6.667v2"
      />
    </svg>
  );
}

export default WaveIcon;
