/**
 * 通用下拉菜单组件族。
 * 导出菜单容器 MenuPopover 及其内部条目 MenuItem、分割线 MenuDivider，
 * 统一菜单的样式与交互，纯展示无业务逻辑。
 */
"use client";

import { Popover, Tooltip } from "antd";
import { ReactNode } from "react";

/**
 * 通用菜单条目。
 * - dimmed：弱化视觉且完全不可交互（pointer-events: none，tooltip 也无法触发）；
 * - disabled：禁用但保留悬停（供 Tooltip 说明禁用原因），点击被拦截；
 * - tooltip：悬停提示文案，配合 disabled 展示禁用原因。
 */
export function MenuItem({ children, onClick, dimmed, disabled, selected, iconRight, tooltip }: {
  children: ReactNode; onClick?: () => void; dimmed?: boolean; disabled?: boolean; selected?: boolean; iconRight?: ReactNode; tooltip?: string;
}) {
  const inactive = dimmed || disabled;
  const item = (
    <div
      className={`menu-popover-item${inactive ? " menu-item-disabled" : ""}`}
      style={dimmed ? { pointerEvents: "none" } : undefined}
    >
    <button
      className={`menu-item-btn${selected ? " selected" : ""}`}
      style={{ color: selected ? undefined : (inactive ? "var(--canvas-text-dim)" : "var(--canvas-text)"), cursor: disabled ? "not-allowed" : undefined }}
      onClick={inactive ? undefined : onClick}>
      <span className="flex-1">{children}</span>
      {iconRight}
    </button>
  </div>
  );
  return tooltip ? <Tooltip title={tooltip} placement="right">{item}</Tooltip> : item;
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
