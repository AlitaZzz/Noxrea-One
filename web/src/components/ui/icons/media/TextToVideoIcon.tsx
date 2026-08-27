/**
 * 文生视频图标（矩形内一个 T），用于「文生视频」视频参考模式。
 */
"use client";

import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function TextToVideoIcon({ className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      style={{ display: "inline-block", width: "1em", height: "1em", verticalAlign: "-0.125em", ...style }}
    >
      <g transform="translate(2.165 2.165)">
        <path d="M9.99 0c.93.05 1.68.82 1.68 1.77v8.22c-.05.9-.78 1.63-1.68 1.67H1.77A1.75 1.75 0 0 1 0 10V1.77C0 .79.8 0 1.77 0zM1.77 1.05c-.4 0-.72.32-.72.72V9.9c0 .4.32.72.72.72H9.9c.4 0 .72-.32.72-.72V1.77c0-.4-.32-.72-.72-.72zm7.19 3.09h-2.4v4.79H5.51v-4.8H3.12V3.1h5.84z" fill="currentColor" />
      </g>
    </svg>
  );
}

export default TextToVideoIcon;