/**
 * 文本输入的项目内出口（隔离第三方 UI 实现，行为与 antd Input 一致）。
 */
"use client";

import { Input, type InputRef } from "antd";
import { type InputHTMLAttributes, type ReactNode, type Ref, useImperativeHandle, useRef } from "react";

export interface AppInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: "small" | "middle" | "large";
  variant?: "outlined" | "borderless" | "filled";
  prefix?: ReactNode;
  allowClear?: boolean;
  showCount?: boolean;
  status?: "error" | "warning";
  onPressEnter?: InputHTMLAttributes<HTMLInputElement>["onKeyDown"];
  ref?: Ref<AppInputHandle>;
}

export interface AppInputHandle { focus(): void; select(): void }

export default function AppInput({ ref, ...props }: AppInputProps) {
  const input = useRef<InputRef>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), select: () => input.current?.select() }), []);
  return <Input {...props} ref={input} />;
}
