"use client";

import { Select } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface AppSelectOption<T extends string | number> { value: T; label: ReactNode; disabled?: boolean }
type Selection<T> =
  | { allowClear?: false; onChange?: (value: T) => void }
  | { allowClear: true; onChange?: (value: T | undefined) => void };
export type AppSelectProps<T extends string | number> = Selection<T> & {
  value?: T;
  options: AppSelectOption<T>[];
  placeholder?: string;
  size?: "small" | "middle" | "large";
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
};

export default function AppSelect<T extends string | number>({ options, ...props }: AppSelectProps<T>) {
  return <Select<T> {...props} options={options.map(({ label, ...option }) => ({ ...option, label: <span>{label}</span>, title: "" }))} />;
}
