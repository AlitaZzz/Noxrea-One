/**
 * 弹窗底部通用按钮。
 * 提供 default / primary / danger 三种视觉变体与加载、禁用态，样式随主题变量自适应。
 */
"use client";

import { type ReactNode,useState } from "react";

interface Props {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  loading?: boolean;
}

const VARIANT_STYLES: Record<string, React.CSSProperties> = {
  default: { background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)", color: "var(--canvas-text)" },
  primary: { background: "#fff", border: "1px solid var(--canvas-border)", color: "#1a1a1a", fontWeight: 500 },
  danger:  { background: "transparent", border: "1px solid var(--canvas-accent)", color: "var(--canvas-accent)" },
};

const HOVER_BG: Record<string, string> = {
  default: "var(--canvas-bg-hover)",
  primary: "#e6e6e6",
  danger:  "var(--canvas-bg-hover)",
};

/** 弹窗底部统一按钮 — 8px 圆角 36px 高度，主题色自适应。 */
export default function ModalButton({ children, onClick, variant = "default", disabled, loading }: Props) {
  const [hovered, setHovered] = useState(false);
  const base = VARIANT_STYLES[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "0 20px", height: 36, borderRadius: 8, fontSize: 13, outline: "none",
        cursor: loading ? "wait" : disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.15s",
        ...base,
        background: hovered && !disabled ? HOVER_BG[variant] : base.background,
      }}
    >
      {loading ? "处理中..." : children}
    </button>
  );
}
