/** Native color control with the project's shadcn theme contract. */
"use client";

import { cn } from "cn";
import type { ChangeEvent, CSSProperties } from "react";

import type { AppControlSize } from "@/components/ui/control-types";

export interface ColorPickerProps {
  value: string;
  onChangeComplete?: (color: string) => void;
  onChange?: (color: string) => void;
  size?: AppControlSize;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

function toHexValue(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
}

const sizeClasses: Record<AppControlSize, string> = {
  sm: "h-6 w-8",
  md: "h-7 w-9",
  lg: "h-8 w-10",
};

export function ColorPicker({
  value,
  onChange,
  onChangeComplete,
  size = "md",
  disabled = false,
  className,
  style,
}: ColorPickerProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const nextColor = event.target.value;
    onChange?.(nextColor);
    onChangeComplete?.(nextColor);
  };

  return (
    <input
      type="color"
      aria-label="Color"
      value={toHexValue(value)}
      disabled={disabled}
      className={cn(
        "block shrink-0 cursor-pointer rounded-md border border-input bg-background p-1 transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        "[&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0",
        className,
      )}
      style={style}
      onChange={handleChange}
    />
  );
}
