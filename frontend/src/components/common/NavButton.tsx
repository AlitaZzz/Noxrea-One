"use client";

import { useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onClick?: (e?: React.MouseEvent) => void;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** 导航/选择类按钮 — 默认透明底，active 时 var(--canvas-bg-elevated) + 左侧高亮条，hover 时 var(--canvas-bg-hover)。 */
export default function NavButton({ children, onClick, active, className = "", style }: Props) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={className}
      style={{
        cursor: "pointer",
        outline: "none",
        border: "none",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 10px",
        fontSize: 13,
        borderRadius: 6,
        transition: "background 0.15s",
        background: active ? "var(--canvas-bg-elevated)" : hovered ? "var(--canvas-bg-hover)" : "transparent",
        color: active ? "var(--canvas-text)" : "var(--canvas-text-secondary)",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
