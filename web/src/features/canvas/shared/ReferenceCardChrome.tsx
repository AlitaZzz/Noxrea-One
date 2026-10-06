"use client";

import { type ReactNode, useEffect, useState } from "react";

import { CloseOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

interface ReferenceHoverPreviewProps {
  children: ReactNode;
  preview: ReactNode;
  disabled?: boolean;
}

export function ReferenceHoverPreview({ children, preview, disabled = false }: ReferenceHoverPreviewProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (disabled) {
      // A disabled preview is a new interaction state; reset Radix's controlled open value
      // while keeping the trigger DOM mounted for an active drag operation.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(false);
    }
  }, [disabled]);

  return (
    <HoverCard
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        if (!disabled) setOpen(nextOpen);
      }}
      openDelay={150}
      closeDelay={0}
    >
      <HoverCardTrigger asChild>
        <div className="inline-flex">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={8}
        className="pointer-events-none w-auto overflow-hidden rounded-xl border-border bg-black p-0 shadow-2xl"
      >
        {preview}
      </HoverCardContent>
    </HoverCard>
  );
}

export function ReferenceIndexBadge({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 flex h-4 items-center justify-center rounded-b bg-black/55 text-[10px] font-semibold whitespace-nowrap text-white">
      {children}
    </span>
  );
}

export function ReferenceRemoveButton({ ariaLabel, onRemove }: { ariaLabel: string; onRemove: () => void }) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={ariaLabel}
      className="absolute -top-1.5 -right-1.5 rounded-full bg-transparent p-0 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/15 hover:text-white"
      onClick={onRemove}
    >
      <CloseOutlined className="size-3" />
    </Button>
  );
}
