/**
 * 文本输入的项目内出口（隔离第三方 UI 实现，行为与 antd Input 一致）。
 */
"use client";

import { Input } from "antd";
import type { InputHTMLAttributes, ReactNode } from "react";

export interface AppInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: "small" | "middle" | "large";
  variant?: "outlined" | "borderless" | "filled";
  prefix?: ReactNode;
  allowClear?: boolean;
}

export default function AppInput(props: AppInputProps) {
  return <Input {...props} />;
}
