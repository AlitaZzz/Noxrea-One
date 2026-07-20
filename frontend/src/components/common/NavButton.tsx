"use client";

import { useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onClick?: (e?: React.MouseEvent) => void;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** 导航/选择类按钮 — 默认透明底，active 时 var(--canvas-bg-elevated)，hover 时 var(--canvas-bg-hover)。 */
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
        gap: 9,
        width: "100%",
        padding: "9px 10px",
        fontSize: 13,
        borderRadius: 8,
        transition: "background 0.15s",
        background: active ? "var(--nav-active-bg)" : hovered ? "var(--nav-hover-bg)" : "transparent",
        color: active ? "var(--canvas-text)" : "var(--canvas-text-dim)",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
