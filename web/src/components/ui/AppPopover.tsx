/**
 * Popover 的项目内出口（隔离第三方 UI 实现，行为与 antd Popover 一致）。
 */
"use client";

import { Popover } from "antd";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import type { PopupTrigger, TooltipPlacement } from "@/components/ui/overlay-types";

export interface AppPopoverProps {
  content: ReactNode;
  children: ReactElement;
  placement?: TooltipPlacement;
  trigger?: PopupTrigger | PopupTrigger[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  arrow?: boolean;
  popupClassName?: string;
  contentStyle?: CSSProperties;
  getPopupContainer?: (trigger: HTMLElement) => HTMLElement;
}

export default function AppPopover({ popupClassName, contentStyle, ...props }: AppPopoverProps) {
  return <Popover {...props} classNames={{ root: popupClassName }} styles={{ container: contentStyle }} />;
}
