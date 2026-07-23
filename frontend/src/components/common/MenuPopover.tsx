"use client";

import { Popover } from "antd";
import { ReactNode } from "react";

// Reusable menu item
export function MenuItem({ children, onClick, dimmed, iconRight }: {
  children: ReactNode; onClick?: () => void; dimmed?: boolean; iconRight?: ReactNode;
}) {
  return (
    <div className="menu-popover-item">
    <button className="menu-item-btn"
      style={{ color: dimmed ? "var(--canvas-text-dim)" : "var(--canvas-text)" }}
      onClick={onClick}>
      <span className="flex-1">{children}</span>
      {iconRight}
    </button>
  </div>
  );
}

// Reusable divider
export function MenuDivider() {
  return <div className="menu-divider" />;
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
      content={<div className="menu-popover">{content}</div>}
      trigger="click" placement={placement || "bottomRight"} open={open} onOpenChange={onOpenChange}
      styles={{ container: { padding: 0, background: "transparent" } }}>
      {trigger}
    </Popover>
  );
}
