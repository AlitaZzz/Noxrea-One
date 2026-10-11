"use client"

import { cn } from "cn"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { useCallback } from "react"

import { useLayerZIndex } from "@/components/ui/modal/layer-context"
import { useContentFocusRingAnchor } from "@/lib/focus-ring"

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
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  focusOnOpen = true,
  restoreFocus = true,
  style,
  ref: forwardedRef,
  ...props
}: PopoverContentProps) {
  const layerZIndex = useLayerZIndex()
  const { handleContentRef, handleCloseAutoFocus } = useContentFocusRingAnchor(restoreFocus)
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      handleContentRef(node)
      if (typeof forwardedRef === "function") forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef, handleContentRef],
  )

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={setRef}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        style={{ ...style, ...(layerZIndex === undefined ? {} : { zIndex: layerZIndex }) }}
        {...props}
        // 焦点仲裁由本封装拥有（类型层已 Omit，这里置于展开之后防运行时绕过），
        // 调用方只能通过 focusOnOpen / restoreFocus 表达意图
        onOpenAutoFocus={(event) => {
          if (!focusOnOpen) event.preventDefault()
        }}
        onCloseAutoFocus={handleCloseAutoFocus}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverAnchorPortal, PopoverContent, PopoverTrigger }
