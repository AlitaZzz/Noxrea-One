/**
 * 面板开关图标（侧栏布局），用于画布左下工具栏的 Canvas Explorer 开关。
 * 用户提供的 20×20 填充矢量，fill 改为 currentColor 以跟随主题。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function PanelIcon({ className, style }: IconProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      className={className}
      style={{ display: "inline-block", ...style }}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="currentColor"
        d="M17.48.01A2.8 2.8 0 0 1 20 2.81V17.2l-.01.28a2.8 2.8 0 0 1-2.5 2.5l-.3.02H2.8a2.8 2.8 0 0 1-2.79-2.52L0 17.2V2.8A2.8 2.8 0 0 1 2.8 0h14.4zM2.8 1.8a1 1 0 0 0-1 1v14.4a1 1 0 0 0 1 1h4.08V1.8zm5.88 16.4h8.52a1 1 0 0 0 1-1V2.8a1 1 0 0 0-1-1H8.68z"
      />
    </svg>
  );
}

export default PanelIcon;
