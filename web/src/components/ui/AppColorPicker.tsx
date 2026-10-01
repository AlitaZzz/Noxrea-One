/**
 * ColorPicker 的项目内出口（隔离第三方 UI 实现，行为与 antd ColorPicker 一致）。
 */
"use client";

import { ColorPicker } from "antd";
export interface AppColorPickerProps {
  value: string;
  onChangeComplete?: (color: string) => void;
  onChange?: (color: string) => void;
  size?: "small" | "middle" | "large";
}

export default function AppColorPicker(props: AppColorPickerProps) {
  return <ColorPicker {...props} format="hex" onChange={(color) => props.onChange?.(color.toHexString())} onChangeComplete={(color) => props.onChangeComplete?.(color.toHexString())} />;
}
