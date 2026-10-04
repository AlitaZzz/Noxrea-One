/**
 * @ 引用候选下拉列表。
 * 展示可引用的图片 / 音频 / 视频素材缩略项。
 * 纯受控组件：选中项由外部（编辑器 suggestion）驱动，键盘事件由 suggestion 的 onKeyDown 统一处理。
 */
"use client";

import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { WaveIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

import { type ReferenceItem, refLabelKey } from "./reference";

interface Props {
  items: ReferenceItem[];
  position: { x: number; y: number };
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: ReferenceItem) => void;
}

const MentionDropdown = memo(function MentionDropdown({ items, position, selectedIndex, onHover, onSelect }: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘导航时让选中项保持可见
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <Popover open modal={false}>
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          className="fixed size-px pointer-events-none"
          style={{ left: position.x, top: position.y }}
        />
      </PopoverAnchor>
      <PopoverContent
        ref={listRef}
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="max-h-[300px] w-[220px] overflow-x-hidden p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
      {items.map((item, i) => (
        <Button
          key={`${item.kind}-${item.src}`}
          type="button"
          variant="ghost"
          data-selected={i === selectedIndex ? "true" : undefined}
          className="h-auto min-h-14 w-full justify-start gap-3 rounded-sm px-3 py-2 text-left data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
          onPointerMove={() => onHover(i)}
          onPointerDown={(e) => {
            // 阻止默认行为，避免抢走编辑器焦点导致 suggestion 提前退出
            e.preventDefault();
            onSelect(item);
          }}
        >
          {item.kind === "audio" ? (
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded border border-border bg-accent text-primary"
            >
              <WaveIcon className="size-[22px]" />
            </div>
          ) : item.kind === "video" ? (
            <video
              src={`${item.thumbnail}#t=0.1`}
              muted
              preload="metadata"
              playsInline
              className="size-10 shrink-0 rounded border border-border bg-accent object-cover"
            />
          ) : (
            <img
              src={item.thumbnail}
              alt={t(refLabelKey(item), { index: item.index + 1 })}
              className="size-10 shrink-0 rounded border border-border object-cover"
            />
          )}
          <span className="text-sm font-medium">
            {t(refLabelKey(item), { index: item.index + 1 })}
          </span>
        </Button>
      ))}
      </PopoverContent>
    </Popover>
  );
});

export default MentionDropdown;
