/**
 * Tooltip 的项目内出口。
 *
 * UI 基础层负责隔离第三方 UI 实现：业务层只认 AppTooltip，
 * 将来替换底层实现时只改这一个文件。行为与 antd Tooltip 完全一致。
 */
"use client";

import { Tooltip } from "antd";
import type { ReactElement, ReactNode } from "react";

import type { TooltipPlacement } from "@/components/ui/overlay-types";

export interface AppTooltipProps {
  title: ReactNode;
  children: ReactElement;
  placement?: TooltipPlacement;
  open?: boolean;
}

export default function AppTooltip(props: AppTooltipProps) {
  return <Tooltip {...props} />;
}
