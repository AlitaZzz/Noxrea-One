/**
 * 空状态的项目内出口（隔离第三方 UI 实现，行为与 antd Empty 一致）。
 */
"use client";

import { Empty } from "antd";
import type { ReactNode } from "react";

export interface AppEmptyProps {
  description?: ReactNode;
}

export default function AppEmpty(props: AppEmptyProps) {
  return <Empty {...props} />;
}
