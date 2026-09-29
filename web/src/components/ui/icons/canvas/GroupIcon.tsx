/**
 * 分组图标（像素风双框选区），用于组节点标题与节点类型展示元数据。
 * 填充风格（fill 路径自带拐角缺口），与 canvas 图标约定一致按 1em 内联、随 currentColor 着色。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function GroupIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 5h1V4h8v5h1V3H5V2H2v3h1v9h6v-1H4zM3 3h1v1H3zM2 22h3v-3H2zm1-2h1v1H3zM19 2v3h3V2zm2 2h-1V3h1zm0 6H10v11h9v1h3v-3h-1zm-2 10h-8v-9h9v8h-1zm2 1h-1v-1h1z" />
    </svg>
  );
}

export default GroupIcon;
