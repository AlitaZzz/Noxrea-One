/**
 * Typography 的项目内出口（隔离第三方 UI 实现）。
 * 仅开放项目使用的 Paragraph 能力，不导出第三方组件对象。
 */
"use client";

import { Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface AppParagraphProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  copyable?: boolean | { text: string };
  ellipsis?: { rows: number; expandable?: boolean; symbol?: ReactNode };
}

function Paragraph(props: AppParagraphProps) {
  return <Typography.Paragraph {...props} />;
}

const AppTypography = { Paragraph };
export default AppTypography;
