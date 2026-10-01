/**
 * Slider 的项目内出口（隔离第三方 UI 实现，行为与 antd Slider 一致）。
 */
"use client";

import { Slider } from "antd";
import type { CSSProperties } from "react";

export interface AppSliderProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
  showTooltip?: boolean;
  className?: string;
  style?: CSSProperties;
  styles?: { rail?: CSSProperties; track?: CSSProperties; handle?: CSSProperties };
}

export default function AppSlider({ showTooltip = true, ...props }: AppSliderProps) {
  return <Slider {...props} tooltip={showTooltip ? undefined : { open: false }} />;
}
