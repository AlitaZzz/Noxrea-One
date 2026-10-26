"use client";

import { type ReactNode, useEffect, useState } from "react";

import { CloseOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card";
import { ResolvedHoverMedia } from "@/features/media/components/ResolvedHoverMedia";

interface ReferenceHoverPreviewProps {
  children: ReactNode;
  /** 逻辑引用值（存储 key 或外部 URL）：只在浮层打开时才换取访问地址 */
  value: string;
  /** 派生缩略宽度（`?w=`），仅对托管值生效；缺省用原图 */
  width?: number;
  mediaType: "image" | "video";
  disabled?: boolean;
}

export function ReferenceHoverPreview({
  children,
  value,
  width,
  mediaType,
  disabled = false,
}: ReferenceHoverPreviewProps) {
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
      <ResolvedHoverMedia
        value={value}
        width={width}
        open={open && !disabled}
        mediaType={mediaType}
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={8}
        className="pointer-events-none w-auto overflow-hidden rounded-xl border-border bg-black p-0 shadow-2xl"
        mediaClassName="block max-h-[240px] max-w-[240px] object-contain"
      />
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
      className="absolute -top-1 -right-1 size-4 rounded-full border-border bg-popover p-0 text-popover-foreground shadow-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent dark:hover:bg-accent"
      onClick={onRemove}
    >
      <CloseOutlined className="size-2.5" />
    </Button>
  );
}
