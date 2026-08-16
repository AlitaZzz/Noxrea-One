/**
 * 25宫格剧情分镜图标，用于「创作」菜单中的「25宫格剧情分镜」项。
 * 书本 / 分镜脚本造型，代表一段完整的多帧故事脚本。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function Storyboard25Icon({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", width: "1em", height: "1em", ...style }}
      aria-hidden="true"
    >
      <path d="M14.5 3H10a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H1.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5H6a1.5 1.5 0 0 1 1.5 1.5.5.5 0 0 0 1 0A1.5 1.5 0 0 1 10 13h4.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5M6 12H2V4h4a1.5 1.5 0 0 1 1.5 1.5v7A2.5 2.5 0 0 0 6 12m8 0h-4c-.541 0-1.068.175-1.5.5v-7A1.5 1.5 0 0 1 10 4h4zm-4-6.5h2.5a.5.5 0 0 1 0 1H10a.5.5 0 1 1 0-1M13 8a.5.5 0 0 1-.5.5H10a.5.5 0 1 1 0-1h2.5a.5.5 0 0 1 .5.5m0 2a.5.5 0 0 1-.5.5H10a.5.5 0 0 1 0-1h2.5a.5.5 0 0 1 .5.5" />
    </svg>
  );
}

export default Storyboard25Icon;