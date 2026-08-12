/**
 * 角色三视图图标，用于「创作」菜单中的「角色三视图」项。
 * 采用 iconify 原始路径（填充风格），与 canvas 其他图标保持 currentColor 着色。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function CharacterThreeViewIcon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 16.67 16.67"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <path d="M14.4 0a2.27 2.27 0 0 1 2.27 2.27V14.4a2.27 2.27 0 0 1-2.28 2.28H2.27l-.23-.01A2.27 2.27 0 0 1 0 14.39V2.27C0 1.1.9.13 2.04.01L2.27 0zM2.26 1.5a.77.77 0 0 0-.77.77V14.4c0 .43.35.78.77.78h.42a5.8 5.8 0 0 1 9.77-2.69 5 5 0 0 1 1.56 2.69h.37c.43 0 .78-.35.78-.78V2.27a.77.77 0 0 0-.78-.77zm6.07 10.74a4.3 4.3 0 0 0-4.08 2.93h8.22c-.2-.64-.56-1.1-1.08-1.64a4.3 4.3 0 0 0-3.06-1.29m0-8.9a3.7 3.7 0 0 1 3.64 3.7c0 2.04-1.63 3.7-3.64 3.7a3.67 3.67 0 0 1-3.65-3.51v-.2c0-2.04 1.63-3.7 3.65-3.7m0 1.5c-1.17 0-2.15.96-2.15 2.2 0 1.16.86 2.08 1.93 2.19l.22.01.21-.01a2.2 2.2 0 0 0 1.93-2.2c0-1.23-.98-2.2-2.14-2.2" />
    </svg>
  );
}

export default CharacterThreeViewIcon;
