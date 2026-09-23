/**
 * 连接节点图标（两节点连线），用于聊天面板操作行。
 */
import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function ConnectNodesIcon({ className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", ...style }}
    >
      <circle cx="4" cy="4" r="1.7" stroke="currentColor" strokeWidth={1.2} />
      <circle cx="12" cy="12" r="1.7" stroke="currentColor" strokeWidth={1.2} />
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.2}
        d="M5.3 5.6c1.4 1.2 2.9 2.6 4.2 4.2"
      />
    </svg>
  );
}

export default ConnectNodesIcon;
