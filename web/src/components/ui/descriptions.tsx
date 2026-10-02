import { cn } from "cn"
import type { CSSProperties, ReactNode } from "react"

export type DescriptionSize = "sm" | "md"

export interface DescriptionsProps {
  items: { key: string; label: ReactNode; children: ReactNode }[]
  column?: number
  size?: DescriptionSize
  bordered?: boolean
  className?: string
  style?: CSSProperties
}

export function Descriptions({
  items,
  column = 3,
  size = "md",
  bordered = false,
  className,
  style,
}: DescriptionsProps) {
  return (
    <dl
      data-slot="descriptions"
      data-size={size}
      data-bordered={bordered || undefined}
      className={cn(
        "grid min-w-0 text-foreground",
        bordered && "overflow-hidden rounded-md border border-border",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, column)}, minmax(0, 1fr))`, ...style }}
    >
      {items.map((item) => (
        <div
          className={cn(
            "min-w-0 px-3 py-2",
            size === "sm" && "px-2.5 py-1.5 text-xs",
            bordered && "border-b border-border last:border-b-0",
          )}
          key={item.key}
        >
          <dt className="mb-1 text-xs text-muted-foreground">{item.label}</dt>
          <dd className="m-0 break-words">{item.children}</dd>
        </div>
      ))}
    </dl>
  )
}

export default Descriptions
