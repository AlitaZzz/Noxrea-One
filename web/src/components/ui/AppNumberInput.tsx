/**
 * 数字输入的项目内出口（隔离第三方 UI 实现，行为与 antd InputNumber 一致）。
 */
"use client";

import { InputNumber } from "antd";
import type { CSSProperties, KeyboardEventHandler, ReactNode } from "react";

export interface AppNumberInputProps {
  value?: number | null;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number | null) => void;
  onPressEnter?: KeyboardEventHandler<HTMLInputElement>;
  size?: "small" | "middle" | "large";
  variant?: "outlined" | "borderless" | "filled";
  controls?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  suffix?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export default function AppNumberInput(props: AppNumberInputProps) {
  return <InputNumber<number> {...props} />;
}
