"use client";

import { useState } from "react";

import { EyeIcon, EyeOffIcon } from "@/components/ui/AppIcon";
import type { InputProps } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

export interface PasswordInputProps extends Omit<InputProps, "type"> {
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  showLabel: string;
  hideLabel: string;
}

export function PasswordInput({
  visible,
  onVisibleChange,
  showLabel,
  hideLabel,
  disabled,
  className,
  ...props
}: PasswordInputProps) {
  const [uncontrolledVisible, setUncontrolledVisible] = useState(false);
  const isVisible = visible ?? uncontrolledVisible;

  const toggle = () => {
    if (disabled) return;
    const next = !isVisible;
    if (visible === undefined) setUncontrolledVisible(next);
    onVisibleChange?.(next);
  };

  return (
    <InputGroup className={className}>
      <InputGroupInput {...props} disabled={disabled} type={isVisible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={isVisible ? hideLabel : showLabel}
          aria-pressed={isVisible}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
          size="icon-xs"
        >
          {isVisible ? <EyeIcon /> : <EyeOffIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
