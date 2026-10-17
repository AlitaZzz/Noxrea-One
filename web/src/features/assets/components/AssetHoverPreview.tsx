/**
 * 资产悬浮预览。
 *
 * 使用项目 HoverCard 负责悬停延迟、Portal、定位、层级和视口碰撞；
 * 资产组件只负责提供触发内容和预览内容。
 */
"use client";

import type { ReactElement } from "react";

import { HoverCard, HoverCardContent, HoverCardMediaContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { AssetItem } from "@/features/assets/types";
import { managedFileUrl, withManagedFileWidth } from "@/lib/file-url";

const PREVIEW_MAX_WIDTH = 400;
const HOVER_OPEN_DELAY = 600;
const HOVER_CLOSE_DELAY = 150;

type AssetPreviewMediaType = AssetItem["mediaType"] | "text";

type AssetPreviewItem = {
  name: string;
  mediaType: AssetPreviewMediaType;
  /** 来源引用：存储 key 或外部 URL；展示时派生访问 URL */
  fileKey?: string;
  plainText?: string;
};

interface Props {
  asset: AssetPreviewItem;
  enabled?: boolean;
  children: ReactElement;
}

export function AssetHoverPreview({ asset, enabled = true, children }: Props) {
  const fileKey = asset.fileKey;
  const isVideo = asset.mediaType === "video";
  const isImage = asset.mediaType === "image";
  const isText = asset.mediaType === "text";
  const bigUrl = withManagedFileWidth(fileKey, PREVIEW_MAX_WIDTH);
  const hasText = typeof asset.plainText === "string" && asset.plainText.trim().length > 0;
  const hasPreviewContent = isText ? hasText : (isImage || isVideo) && Boolean(fileKey);

  if (!enabled || !hasPreviewContent) return children;

  return (
    <HoverCard openDelay={HOVER_OPEN_DELAY} closeDelay={HOVER_CLOSE_DELAY}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {isText ? (
        <HoverCardContent
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={8}
          className="nodrag nopan nowheel w-fit max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border-border bg-black p-0 shadow-2xl"
        >
          <div className="max-h-[min(340px,70vh)] min-w-48 max-w-[min(400px,calc(100vw-1rem))] overflow-y-auto whitespace-pre-wrap break-words bg-popover px-4 py-3 text-sm leading-6 text-popover-foreground">
            {asset.plainText}
          </div>
        </HoverCardContent>
      ) : (
        <HoverCardMediaContent
          mediaType={isVideo ? "video" : "image"}
          src={(isVideo ? managedFileUrl(fileKey) : bigUrl)!}
          alt={asset.name}
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={8}
          className="nodrag nopan nowheel w-fit max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border-border bg-black p-0 shadow-2xl"
          mediaClassName="block max-h-[min(340px,70vh)] max-w-[min(400px,calc(100vw-1rem))] object-contain"
        />
      )}
    </HoverCard>
  );
}
