"use client"

import { cn } from "cn"
import type { CSSProperties, ReactNode } from "react"
import { useState } from "react"

import { Copy } from "@/components/ui/AppIcon"
import { Button } from "@/components/ui/button"

export interface ParagraphProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
  copyable?: boolean | { text: string }
  ellipsis?: { rows: number; expandable?: boolean; symbol?: ReactNode }
}

export function Paragraph({ children, className, style, copyable, ellipsis }: ParagraphProps) {
  const [expanded, setExpanded] = useState(false)
  const copyText = typeof copyable === "object" ? copyable.text : typeof children === "string" ? children : ""
  const collapsed = Boolean(ellipsis && !expanded)

  const copy = () => {
    if (copyText && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(copyText)
    }
  }

  return (
    <p data-slot="typography-paragraph" data-expanded={expanded || undefined} className={cn("relative mb-4 text-foreground", className)} style={style}>
      <span
        className={cn("break-words", collapsed && "overflow-hidden")}
        style={collapsed ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: ellipsis?.rows } : undefined}
      >
        {children}
      </span>
      {ellipsis?.expandable && (
        <Button type="button" variant="link" size="sm" className="h-auto p-0 align-baseline" onClick={() => setExpanded((current) => !current)}>
          {ellipsis.symbol ?? "Expand"}
        </Button>
      )}
      {copyable && (
        <Button type="button" variant="ghost" size="icon-xs" className="ml-1 align-baseline" aria-label="Copy" onClick={copy} disabled={!copyText}>
          <Copy aria-hidden="true" />
        </Button>
      )}
    </p>
  )
}

const Typography = { Paragraph }
export default Typography
