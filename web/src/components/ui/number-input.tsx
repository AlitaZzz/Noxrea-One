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

export interface NumberInputProps
  extends Omit<
    React.ComponentProps<"input">,
    "defaultValue" | "max" | "min" | "onChange" | "size" | "step" | "type" | "value"
  > {
  value?: number | null
  min?: number
  max?: number
  step?: number
  /** 键入允许的最大小数位；超出位数直接截断（与 step 步进精度对齐）。不传不限制 */
  precision?: number
  onChange?: (value: number | null) => void
  onPressEnter?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  controls?: boolean
  suffix?: React.ReactNode
}

function formatValue(value: number | null | undefined): string {
  return value == null ? "" : String(value)
}

function clamp(value: number, min?: number, max?: number): number {
  return Math.min(max ?? value, Math.max(min ?? value, value))
}

function stepValue(
  value: number | null | undefined,
  direction: 1 | -1,
  step: number,
  min?: number,
  max?: number,
): number {
  const next = (value ?? min ?? 0) + direction * step
  const precision = Math.max(0, (String(step).split(".")[1] ?? "").length)
  return clamp(Number(next.toFixed(precision)), min, max)
}

/**
 * 草稿解析：聚焦期保留用户键入的原文，按前缀数值上报。
 * Number("1.") = 1、Number("1.0") = 1，部分小数不会中断键入；
 * 空串或非数值文本上报 null，失焦后显示回归 value 的规范化字符串。
 */
function parseDraft(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** 小数位超限时截断键入文本（"1.055" + precision 2 → "1.05"）；precision 0 连小数点一起截去 */
function clampDraftPrecision(raw: string, precision: number): string {
  const dot = raw.indexOf(".")
  if (dot === -1 || raw.length - dot - 1 <= precision) return raw
  return raw.slice(0, precision > 0 ? dot + 1 + precision : dot)
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    controls = true,
    value,
    min,
    max,
    step = 1,
    precision,
    suffix,
    disabled,
    className,
    style,
    onChange,
    onPressEnter,
    onKeyDown,
    onBlur,
    ...props
  },
  ref,
) {
  // 聚焦期草稿：`type="number"` 在 "1." 这类部分小数状态下 .value 读数为空（badInput），
  // 受控回写会在下一次键入时把用户可见文本抹掉（数字被"吃掉"）。
  // 聚焦显示键入原文、失焦显示规范化值，是受控数字输入的标准解法。
  const [draft, setDraft] = React.useState<string | null>(null)
  // 受控属主当前持有的值：区分「属主采纳了草稿上报值」与「外部改值（如联动滑杆）」
  const emittedRef = React.useRef<number | null>(value ?? null)

  // 外部改值（≠ 草稿上报值）→ 放弃草稿，跟随外部值
  React.useEffect(() => {
    if (value === emittedRef.current) return
    emittedRef.current = value ?? null
    setDraft(null)
  }, [value])

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = precision == null
      ? event.target.value
      : clampDraftPrecision(event.target.value, precision)
    setDraft(raw)
    const parsed = parseDraft(raw)
    emittedRef.current = parsed
    onChange?.(parsed)
  }

  const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    setDraft(null)
    onBlur?.(event)
  }

  // type="number" 的原生 ↑/↓ 步进随 text 类型消失，改为等价实现（min/max 钳位由 stepValue 保证）
  const adjust = (direction: 1 | -1) => {
    if (disabled) return
    const current = value != null && Number.isFinite(value) ? value : null
    const next = stepValue(current, direction, step, min, max)
    emittedRef.current = next
    // 按钮与 ↑/↓ 键不经过 handleChange，直接把步进结果作为草稿立即显示
    setDraft(String(next))
    onChange?.(next)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault()
      adjust(1)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      adjust(-1)
      return
    }
    if (event.key === "Enter") onPressEnter?.(event)
    onKeyDown?.(event)
  }

  return (
    <InputGroup className={className} style={style}>
      <InputGroupInput
        {...props}
        ref={ref}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-valuenow={value ?? undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        value={draft ?? formatValue(value)}
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {suffix != null && (
        <InputGroupAddon align="inline-end" className="pr-2">
          <InputGroupText>{suffix}</InputGroupText>
        </InputGroupAddon>
      )}
      {controls && (
        <InputGroupAddon align="inline-end" className="h-full flex-col gap-0 border-s border-input p-0">
          {/* 上下步进：flex-col 堆叠。容器继承 Addon 的横向 flex，漏写会让两枚
              size-6 按钮并排躺下（占 ~44px），把输入框的文本区挤到只剩一个字符 */}
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
