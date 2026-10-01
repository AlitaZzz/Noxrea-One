"use client";

import { Input } from "antd";
import type { ReactNode } from "react";

import type { AppInputProps } from "@/components/ui/AppInput";

export interface AppPasswordInputProps extends Omit<AppInputProps, "ref"> {
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  renderVisibilityIcon?: (visible: boolean) => ReactNode;
}

export default function AppPasswordInput({ visible, onVisibleChange, renderVisibilityIcon, ...props }: AppPasswordInputProps) {
  return <Input.Password {...props} iconRender={renderVisibilityIcon}
    visibilityToggle={{ visible, onVisibleChange }} />;
}
