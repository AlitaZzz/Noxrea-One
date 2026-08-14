/**
 * 12 宫格图标（3×4 网格 + 右下角 12），用于节点工具条的多视角截图操作。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function Grid12Icon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      {/* 数字 12 (右下角) */}
      <path fill="currentColor" d="M10.224 15.345h-.992V10.21l.8.008-2.152 1.416v-1l1.44-.944h.904zM11.435 14.681l1.904-1.96q.296-.303.488-.528.2-.231.304-.44.104-.207.104-.456 0-.456-.232-.656-.233-.2-.656-.2-.448 0-.664.224-.216.225-.24.696h-.968q0-.519.232-.912a1.6 1.6 0 0 1 .664-.616q.432-.224 1-.224.56 0 .968.208.415.208.648.592.232.376.232.888 0 .336-.136.632-.129.297-.408.64a14 14 0 0 1-.752.816l-1.416 1.432-.112-.304h2.88v.832h-3.832zM12 1.5A2.5 2.5 0 0 1 14.5 4v4a.5.5 0 0 1-.5.5H6.5V14a.5.5 0 0 1-.5.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5zM2.5 12A1.5 1.5 0 0 0 4 13.5h1.5v-2h-3zm0-1.5h3v-2h-3zm8-5v2h3v-2zm-8 2h3v-2h-3zm4 0h3v-2h-3zm4-3h3V4A1.5 1.5 0 0 0 12 2.5h-1.5zM4 2.5A1.5 1.5 0 0 0 2.5 4v.5h3v-2zm2.5 2h3v-2h-3z" />
    </svg>
  );
}

export default Grid12Icon;