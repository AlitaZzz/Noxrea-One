/**
 * Descriptions 的项目内出口（隔离第三方 UI 实现，行为与 antd Descriptions 一致）。
 * 列表数据由项目接口声明，内部使用第三方布局实现。
 */
"use client";

import { Descriptions } from "antd";
import type { ReactNode } from "react";

export interface AppDescriptionsProps {
  items: { key: string; label: ReactNode; children: ReactNode }[];
  column?: number;
  size?: "small" | "middle" | "default";
  bordered?: boolean;
  className?: string;
}

export default function AppDescriptions(props: AppDescriptionsProps) {
  return <Descriptions {...props} />;
}
