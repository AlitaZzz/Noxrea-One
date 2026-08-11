/**
 * 通用下拉菜单组件族。
 * 导出菜单容器 MenuPopover 及其内部条目 MenuItem、分割线 MenuDivider，
 * 统一菜单的样式与交互，纯展示无业务逻辑。
 */
"use client";

import { Popover } from "antd";
import { ReactNode } from "react";

// Reusable menu item
export function MenuItem({ children, onClick, dimmed, selected, iconRight }: {
  children: ReactNode; onClick?: () => void; dimmed?: boolean; selected?: boolean; iconRight?: ReactNode;
}) {
  return (
    <div
      className={`menu-popover-item${dimmed ? " menu-item-disabled" : ""}`}
      style={dimmed ? { pointerEvents: "none" } : undefined}
    >
    <button
      className={`menu-item-btn${selected ? " selected" : ""}`}
      style={{ color: selected ? undefined : (dimmed ? "var(--canvas-text-dim)" : "var(--canvas-text)") }}
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
export function MenuPopover({ open, onOpenChange, trigger, placement, content, overlayClassName }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trigger: ReactNode;
  placement?: "bottomLeft" | "bottomRight" | "topLeft" | "topRight" | "top" | "bottom";
  content: ReactNode;
  overlayClassName?: string;
}) {
  return (
    <Popover
      content={<div className="menu-popover">{content}</div>}
      trigger="click" placement={placement || "bottomRight"} open={open} onOpenChange={onOpenChange}
      overlayClassName={overlayClassName}
      styles={{ container: { padding: 0, background: "transparent" } }}>
      {trigger}
    </Popover>
  );
}
