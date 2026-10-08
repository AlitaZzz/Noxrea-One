"use client"

import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"

import { useLayerZIndex } from "@/components/ui/modal/layer-context"

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverAnchorPortal({
  children,
  container,
}: {
  children: React.ReactNode
  container?: Element | DocumentFragment | null
}) {
  return <PopoverPrimitive.Portal container={container}>{children}</PopoverPrimitive.Portal>
}

type PopoverContentProps = Omit<
  React.ComponentProps<typeof PopoverPrimitive.Content>,
  "onOpenAutoFocus" | "onCloseAutoFocus" | "onInteractOutside" | "onPointerDown"
> & {
  focusOnOpen?: boolean
  restoreFocus?: boolean
  preserveFocusOutsideSelector?: string
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  focusOnOpen = true,
  restoreFocus = true,
  preserveFocusOutsideSelector,
  style,
  ...props
}: PopoverContentProps) {
  // Radix restores the trigger on keyboard and internal actions; outside pointer actions keep the browser's focus.
  const pointerInteractionRef = React.useRef(false)
  const layerZIndex = useLayerZIndex()

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
          if (!focusOnOpen) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (event.detail.originalEvent.type !== "pointerdown") return
          pointerInteractionRef.current = true
          const target = event.target
          const preserveFocus =
            preserveFocusOutsideSelector &&
            target instanceof Element &&
            target.closest(preserveFocusOutsideSelector)
          if (preserveFocus) return
          const activeElement = document.activeElement
          if (activeElement instanceof HTMLElement) activeElement.blur()
        }}
        onCloseAutoFocus={(event) => {
          const pointerInteraction = pointerInteractionRef.current
          pointerInteractionRef.current = false
          if ((pointerInteraction || !restoreFocus) && !event.defaultPrevented) event.preventDefault()
        }}
        style={{ ...style, ...(layerZIndex === undefined ? {} : { zIndex: layerZIndex }) }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverAnchorPortal, PopoverContent, PopoverTrigger }
