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
import { Popover, PopoverAnchor, PopoverAnchorPortal, PopoverContent } from "@/components/ui/popover";
import { ResolvedImage, ResolvedVideo } from "@/features/media/components/ResolvedMedia";

import { type ReferenceItem, refLabelKey, refThumbnailUrl } from "./reference";

/** 单个候选行：缩略地址按条目解析（避免在列表 map 中调用 Hook） */
function MentionOption({ item, selected, onHover, onSelect }: {
  item: ReferenceItem;
  selected: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  // 缩略地址按条目派生一次：视频取定帧、图片走缩略档位；预设没有 src（不产出缩略）
  const thumbnail = item.kind === "image" || item.kind === "video"
    ? refThumbnailUrl(item.src, item.kind)
    : undefined;
  return (
    <Button
      type="button"
      variant="ghost"
      data-selected={selected ? "true" : undefined}
      className="h-auto min-h-14 w-full justify-start gap-3 rounded-sm px-3 py-2 text-left data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
      onPointerMove={onHover}
      onClick={onSelect}
    >
      {item.kind === "audio" ? (
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded border border-border bg-accent text-primary"
        >
          <WaveIcon className="size-[22px]" />
        </div>
      ) : item.kind === "video" ? (
        <ResolvedVideo
          value={thumbnail}
          crossOrigin="anonymous"
          muted
          preload="metadata"
          playsInline
          className="size-10 shrink-0 rounded border border-border bg-accent object-cover"
          fallback={<span className="size-10 shrink-0 rounded border border-border bg-accent" aria-hidden="true" />}
        />
      ) : (
        <ResolvedImage
          value={thumbnail}
          alt={t(refLabelKey(item), { index: item.index + 1 })}
          className="size-10 shrink-0 rounded border border-border object-cover"
          fallback={<span className="size-10 shrink-0 rounded border border-border bg-accent" aria-hidden="true" />}
        />
      )}
      <span className="text-sm font-medium">
        {t(refLabelKey(item), { index: item.index + 1 })}
      </span>
    </Button>
  );
}

interface Props {
  items: ReferenceItem[];
  position: { x: number; y: number };
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: ReferenceItem) => void;
  onClose: () => void;
}

const MentionDropdown = memo(function MentionDropdown({ items, position, selectedIndex, onHover, onSelect, onClose }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘导航时让选中项保持可见
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <Popover
      open
      modal={false}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <PopoverAnchorPortal>
        <PopoverAnchor asChild>
          <span
            aria-hidden="true"
            tabIndex={-1}
            className="fixed size-px pointer-events-none"
            style={{ left: position.x, top: position.y }}
          />
        </PopoverAnchor>
      </PopoverAnchorPortal>
      <PopoverContent
        ref={listRef}
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="max-h-[300px] w-[220px] overflow-x-hidden p-1"
        focusOnOpen={false}
        restoreFocus={false}
      >
      {items.map((item, i) => (
        <MentionOption
          key={`${item.kind}-${item.src}`}
          item={item}
          selected={i === selectedIndex}
          onHover={() => onHover(i)}
          onSelect={() => onSelect(item)}
        />
      ))}
      </PopoverContent>
    </Popover>
  );
});

export default MentionDropdown;
