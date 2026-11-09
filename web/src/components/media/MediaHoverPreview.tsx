/**
 * 媒体悬浮预览（shared）。
 *
 * 使用项目 HoverCard 负责悬停延迟、Portal、定位、层级和视口碰撞；
 * 调用方只负责提供触发内容和预览所需的媒体描述，不感知资产等领域类型。
 */
"use client";

import { type ReactElement, useState } from "react";

import { ResolvedHoverMedia } from "@/components/media/ResolvedHoverMedia";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { MediaType } from "@/types/media";

const PREVIEW_MAX_WIDTH = 400;
const HOVER_OPEN_DELAY = 600;
const HOVER_CLOSE_DELAY = 150;

/** `text` 是预览专用类别：纯文本没有媒体 URL，直接展示内容。 */
export type MediaHoverPreviewType = MediaType | "text";

export interface MediaHoverPreviewProps {
  /** 展示名（图片 alt / 可访问名称来源） */
  name: string;
  mediaType: MediaHoverPreviewType;
  /** 来源引用：存储 key 或外部 URL；展示时派生访问 URL */
  fileKey?: string;
  /** 纯文本预览内容（mediaType 为 "text" 时使用） */
  plainText?: string;
  enabled?: boolean;
  children: ReactElement;
}

export function MediaHoverPreview({
  name,
  mediaType,
  fileKey,
  plainText,
  enabled = true,
  children,
}: MediaHoverPreviewProps) {
  const isVideo = mediaType === "video";
  const isImage = mediaType === "image";
  const isText = mediaType === "text";
  const hasText = typeof plainText === "string" && plainText.trim().length > 0;
  const hasPreviewContent = isText ? hasText : (isImage || isVideo) && Boolean(fileKey);
  // 受控 open：访问地址的解析推迟到浮层真正打开（ResolvedHoverMedia），
  // 网格里每个未被悬停的卡片都不发描述请求
  const [open, setOpen] = useState(false);

  if (!enabled || !hasPreviewContent) {
    // 停用 / 无预览内容期间不渲染浮层；重新启用时必须从关闭态开始，
    // 否则会直接弹出上一次悬停留下的打开态
    if (open) setOpen(false);
    return children;
  }

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={HOVER_OPEN_DELAY}
      closeDelay={HOVER_CLOSE_DELAY}
    >
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
            {plainText}
          </div>
        </HoverCardContent>
      ) : (
        <ResolvedHoverMedia
          value={fileKey!}
          // 视频用原图（首帧由浏览器解码）、图片用缩放档位
          width={isVideo ? undefined : PREVIEW_MAX_WIDTH}
          open={open}
          mediaType={isVideo ? "video" : "image"}
          alt={name}
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
