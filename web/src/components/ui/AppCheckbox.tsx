/**
 * Checkbox 的项目内出口（隔离第三方 UI 实现，行为与 antd Checkbox 一致）。
 */
"use client";

import { Checkbox } from "antd";
import type { ReactNode } from "react";

export interface AppCheckboxProps {
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  children?: ReactNode;
}

export default function AppCheckbox(props: AppCheckboxProps) {
  return <Checkbox {...props} onChange={(event) => props.onChange?.(event.target.checked)} />;
}
