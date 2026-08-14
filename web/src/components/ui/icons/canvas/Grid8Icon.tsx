/**
 * 8 宫格图标（3×4 网格 + 右下角细体 8），用于节点工具条的多视角截图操作。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function Grid8Icon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      {/* 数字 8 (右下角) */}
      <path fill="currentColor" d="M11.5 9.5c.78 0 1.4.58 1.4 1.34 0 .48-.24.9-.62 1.14.48.24.78.7.78 1.25 0 .88-.7 1.52-1.56 1.52s-1.56-.64-1.56-1.52c0-.55.3-1.01.78-1.25-.38-.24-.62-.66-.62-1.14 0-.76.62-1.34 1.4-1.34zm0 .83c-.36 0-.62.24-.62.53 0 .28.26.52.62.52s.62-.24.62-.52c0-.29-.26-.53-.62-.53zm0 2.22c-.44 0-.76.3-.76.68 0 .38.32.68.76.68s.76-.3.76-.68c0-.38-.32-.68-.76-.68z" />

      {/* 3×4 网格：外框 + 2条横线 + 3条竖线（与 12 图标一致） */}
      <path fill="currentColor" d="M12 1.5A2.5 2.5 0 0 1 14.5 4v4a.5.5 0 0 1-.5.5H6.5V14a.5.5 0 0 1-.5.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5zM2.5 12A1.5 1.5 0 0 0 4 13.5h1.5v-2h-3zm0-1.5h3v-2h-3zm8-5v2h3v-2zm-8 2h3v-2h-3zm4 0h3v-2h-3zm4-3h3V4A1.5 1.5 0 0 0 12 2.5h-1.5zM4 2.5A1.5 1.5 0 0 0 2.5 4v.5h3v-2zm2.5 2h3v-2h-3z" />
    </svg>
  );
}

export default Grid8Icon;