/**
 * Slider 的项目内出口（隔离第三方 UI 实现，行为与 antd Slider 一致）。
 */
"use client";

import { Slider } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface AppSliderProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
  showTooltip?: boolean;
  formatTooltip?: (value: number) => ReactNode;
  className?: string;
  style?: CSSProperties;
  styles?: { rail?: CSSProperties; track?: CSSProperties; handle?: CSSProperties };
}

export default function AppSlider({ showTooltip = true, formatTooltip, ...props }: AppSliderProps) {
  return <Slider {...props} tooltip={showTooltip ? { formatter: formatTooltip ? (value) => value === undefined ? null : formatTooltip(value) : undefined } : { open: false }} />;
}
