/**
 * Drawer 的项目内出口（隔离第三方 UI 实现，行为与 antd Drawer 一致）。
 */
"use client";

import { Drawer } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface AppDrawerProps {
  open: boolean;
  onClose: () => void;
  width: number;
  mask?: boolean;
  placement?: "left" | "right";
  closePlacement?: "start" | "end";
  closeLabel?: string;
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  destroyOnHidden?: boolean;
  styles?: { header?: CSSProperties; body?: CSSProperties; panel?: CSSProperties };
}

export default function AppDrawer({ width, closePlacement = "end", closeLabel, styles, ...props }: AppDrawerProps) {
  return <Drawer {...props} size={width} closable={{ placement: closePlacement, "aria-label": closeLabel }}
    styles={{ header: styles?.header, body: styles?.body, section: styles?.panel }} />;
}
