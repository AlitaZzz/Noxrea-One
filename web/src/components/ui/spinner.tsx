import { Loading03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

function Spinner({ className, width: _width, height: _height, strokeWidth: _strokeWidth, ...props }: React.ComponentProps<"svg">) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} width={16} height={16} {...props} />
  )
}

export { Spinner }
