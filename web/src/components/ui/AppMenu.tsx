/**
 * Menu 的项目内出口（隔离第三方 UI 实现，行为与 antd Menu 一致）。
 */
"use client";

import { Menu, type MenuProps } from "antd";
import type { CSSProperties, ReactNode } from "react";

export type AppMenuItem =
  | { type: "divider"; key?: string }
  | { key: string; label?: ReactNode; icon?: ReactNode; extra?: ReactNode; disabled?: boolean; danger?: boolean; children?: AppMenuItem[]; type?: "group" };

export interface AppMenuProps {
  items?: AppMenuItem[];
  onClick?: (item: { key: string }) => void;
  selectedKeys?: string[];
  selectable?: boolean;
  style?: CSSProperties;
}

function toMenuItems(items: AppMenuItem[]): NonNullable<MenuProps["items"]> {
  return items.map((item) => {
    if (item.type === "divider") return item;
    const { children, type, ...props } = item;
    if (type === "group") return { ...props, type, children: children ? toMenuItems(children) : [] };
    if (children) return { ...props, children: toMenuItems(children) };
    return props;
  });
}

export function toMenuProps({ onClick, items, ...props }: AppMenuProps): MenuProps {
  return { ...props, items: items ? toMenuItems(items) : undefined, onClick: onClick ? ({ key }) => onClick({ key }) : undefined };
}

export default function AppMenu(props: AppMenuProps) {
  return <Menu {...toMenuProps(props)} />;
}
