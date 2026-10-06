"use client"

import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"
import * as React from "react"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      aria-valuemin={0}
      aria-valuemax={props.max ?? 100}
      aria-valuenow={value ?? 0}
      value={value}
      className={cn(
        "relative flex h-1.5 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }

function CircularProgress({ value, size = 40, className }: { value: number; size?: number; className?: string }) {
  const bounded = Math.max(0, Math.min(100, value))
  const radius = 18
  const circumference = 2 * Math.PI * radius
  return (
    <div
      role="progressbar"
      data-slot="circular-progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={bounded}
      className={cn("relative inline-flex items-center justify-center text-primary", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 40 40" className="size-full -rotate-90">
        <circle cx="20" cy="20" r={radius} fill="none" stroke="currentColor" strokeWidth="4" opacity="0.2" />
        <circle cx="20" cy="20" r={radius} fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - bounded / 100)} strokeLinecap="round" />
      </svg>
      <span className="absolute text-[10px]">{bounded}%</span>
    </div>
  )
}

export { CircularProgress }
