"use client"

import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Radix restores the trigger on close; pointer actions should keep the browser's current focus.
  const pointerInteractionRef = React.useRef(false)

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        onOpenAutoFocus={(event) => {
          pointerInteractionRef.current = false
          onOpenAutoFocus?.(event)
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event)
          if (!event.defaultPrevented) pointerInteractionRef.current = true
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event)
          if (event.defaultPrevented) return

          pointerInteractionRef.current = true
          const activeElement = document.activeElement
          if (activeElement instanceof HTMLElement) activeElement.blur()
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          const pointerInteraction = pointerInteractionRef.current
          pointerInteractionRef.current = false
          if (pointerInteraction && !event.defaultPrevented) event.preventDefault()
        }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
