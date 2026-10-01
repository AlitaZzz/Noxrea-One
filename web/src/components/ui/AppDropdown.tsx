/**
 * Dropdown 的项目内出口（隔离第三方 UI 实现，行为与 antd Dropdown 一致）。
 */
"use client";

import { Dropdown } from "antd";
import type { ReactElement } from "react";

import { type AppMenuProps, toMenuProps } from "@/components/ui/AppMenu";
import type { PopupPlacement, PopupTrigger } from "@/components/ui/overlay-types";

export interface AppDropdownProps {
  children: ReactElement;
  menu: AppMenuProps;
  placement?: PopupPlacement;
  trigger?: Exclude<PopupTrigger, "focus">[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function AppDropdown({ menu, onOpenChange, ...props }: AppDropdownProps) {
  return <Dropdown {...props} menu={toMenuProps(menu)} onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined} />;
}
