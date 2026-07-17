"use client";

import { ReactNode } from "react";
import { Popover } from "antd";

// Standard menu item styles — matches CenterToolbar
const itemStyle: React.CSSProperties = {
  background: "transparent", border: "none", cursor: "pointer",
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 13,
  color: "var(--canvas-text)", borderRadius: 6,
  display: "flex", alignItems: "center", gap: 8,
};

// Reusable menu item
export function MenuItem({ children, onClick, dimmed, iconRight }: {
  children: ReactNode; onClick?: () => void; dimmed?: boolean; iconRight?: ReactNode;
}) {
  return (
    <button
      className="menu-popover-item"
      style={{ ...itemStyle, color: dimmed ? "var(--canvas-text-dim)" : "var(--canvas-text)" }}
      onClick={onClick}
    >
      <span className="flex-1">{children}</span>
      {iconRight}
    </button>
  );
}

// Reusable divider
export function MenuDivider() {
  return <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />;
}

// Reusable popover menu
export function MenuPopover({ open, onOpenChange, trigger, placement, content }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trigger: ReactNode;
  placement?: "bottomLeft" | "bottomRight" | "topLeft" | "topRight" | "top" | "bottom";
  content: ReactNode;
}) {
  return (
    <Popover
      content={
        <div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 190 }}>
          <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
          {content}
        </div>
      }
      trigger="click"
      placement={placement || "bottomRight"}
      open={open}
      onOpenChange={onOpenChange}
    >
      {trigger}
    </Popover>
  );
}
