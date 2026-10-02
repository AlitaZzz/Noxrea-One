"use client"

import { ChevronDown, ChevronUp } from "lucide-react"
import * as React from "react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export interface NumberInputProps
  extends Omit<
    React.ComponentProps<"input">,
    "defaultValue" | "max" | "min" | "onChange" | "size" | "step" | "type" | "value"
  > {
  value?: number | null
  min?: number
  max?: number
  step?: number
  onChange?: (value: number | null) => void
  onPressEnter?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  controls?: boolean
  suffix?: React.ReactNode
}

function displayValue(value: number | null | undefined): string {
  return value == null ? "" : String(value)
}

function clamp(value: number, min?: number, max?: number): number {
  return Math.min(max ?? value, Math.max(min ?? value, value))
}

function stepValue(value: number | null | undefined, direction: 1 | -1, step: number, min?: number, max?: number): number {
  const next = (value ?? min ?? 0) + direction * step
  const precision = Math.max(0, (String(step).split(".")[1] ?? "").length)
  return clamp(Number(next.toFixed(precision)), min, max)
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    controls = true,
    value,
    min,
    max,
    step = 1,
    suffix,
    disabled,
    className,
    style,
    onChange,
    onPressEnter,
    onKeyDown,
    ...props
  },
  ref,
) {
  const emitChange = (next: string) => {
    if (next.trim() === "") {
      onChange?.(null)
      return
    }
    const parsed = Number(next)
    onChange?.(Number.isFinite(parsed) ? parsed : null)
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    emitChange(event.target.value)
  }

  const adjust = (direction: 1 | -1) => {
    if (disabled) return
    const current = value == null ? null : Number.isFinite(value) ? value : null
    emitChange(String(stepValue(current, direction, step, min, max)))
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onPressEnter?.(event)
    onKeyDown?.(event)
  }

  return (
    <InputGroup className={className} style={style}>
      <InputGroupInput
        {...props}
        ref={ref}
        type="number"
        value={displayValue(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className={cn(
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        )}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {suffix != null && (
        <InputGroupAddon align="inline-end" className="pr-2">
          <InputGroupText>{suffix}</InputGroupText>
        </InputGroupAddon>
      )}
      {controls && (
        <InputGroupAddon align="inline-end" className="h-full gap-0 border-s border-input p-0">
          <InputGroupButton
            aria-label="Increase value"
            size="icon-xs"
            tabIndex={-1}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => adjust(1)}
            className="h-1/2 min-h-0 rounded-none"
          >
            <ChevronUp aria-hidden="true" />
          </InputGroupButton>
          <InputGroupButton
            aria-label="Decrease value"
            size="icon-xs"
            tabIndex={-1}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => adjust(-1)}
            className="h-1/2 min-h-0 rounded-none"
          >
            <ChevronDown aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
})

export { NumberInput }
export default NumberInput
