/**
 * 参考图标（摄像机 + 加号），用于「全能参考」等视频参考模式。
 */
"use client";

import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function VideoRefIcon({ className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      style={{ display: "inline-block", width: "1em", height: "1em", verticalAlign: "-0.125em", ...style }}
    >
      <g transform="translate(1.805 1.895)">
        <path d="M6.18.55c.13 0 .24.1.24.23v.59c0 .12-.1.23-.24.23H1.77c-.4 0-.72.32-.72.72v8.13c0 .4.32.71.72.71H9.9c.4 0 .72-.32.72-.71V6.2q.02-.21.23-.23h.58c.13 0 .24.1.24.23v4.33c-.05.9-.78 1.63-1.68 1.67H1.77c-.95 0-1.72-.74-1.77-1.67V2.32C0 1.34.8.55 1.77.55zM9.7.15c.07-.2.36-.2.44 0l.53 1.44q.03.1.14.14l1.43.53c.2.07.2.36 0 .44l-1.43.53a.2.2 0 0 0-.14.14l-.53 1.43c-.08.2-.37.2-.44 0l-.53-1.43a.2.2 0 0 0-.14-.14L7.59 2.7a.23.23 0 0 1 0-.44l1.44-.53a.2.2 0 0 0 .14-.14z" fill="currentColor" />
      </g>
    </svg>
  );
}

export default VideoRefIcon;