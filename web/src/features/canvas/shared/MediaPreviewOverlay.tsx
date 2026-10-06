/**
 * 全屏媒体预览 Dialog：图片 / 视频共用。
 *
 * 图片支持多图切换、下载和缩略图选择；视频渲染原生播放器。
 * 浮层、焦点、Esc、滚动锁定和层级由项目 Dialog 统一管理。
 */
"use client";

import { useCallback, useEffect } from "react";

import { CloseOutlined, DownloadOutlined, LeftOutlined, RightOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

import VideoPlayer from "./VideoPlayer";

export interface PreviewItem {
  url: string;
  mediaType: "image" | "video";
}

interface Props {
  open: boolean;
  items: PreviewItem[];
  index: number;
  onIndexChange?: (i: number) => void;
  onClose: () => void;
}

export default function MediaPreviewOverlay({ open, items, index, onIndexChange, onClose }: Props) {
  const count = items.length;
  const safeIndex = count === 0 ? 0 : Math.max(0, Math.min(index, count - 1));
  const current = items[safeIndex];

  const go = useCallback((direction: number) => {
    if (count <= 1) return;
    onIndexChange?.((safeIndex + direction + count) % count);
  }, [count, onIndexChange, safeIndex]);

  useEffect(() => {
    if (!open || count <= 1) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      go(event.key === "ArrowLeft" ? -1 : 1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [count, go, open]);

  const handleDownload = () => {
    if (!current?.url) return;
    const sep = current.url.includes("?") ? "&" : "?";
    const a = document.createElement("a");
    a.href = `${current.url}${sep}${new URLSearchParams({ download: "true" }).toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        global
        showCloseButton={false}
        className="nodrag flex h-screen max-h-screen w-screen max-w-none items-center justify-center overflow-hidden rounded-none bg-card/55 p-0 text-foreground shadow-none backdrop-blur-md ring-0 sm:max-w-none"
        onClick={onClose}
      >
        <DialogTitle className="sr-only">Media preview</DialogTitle>
        <DialogDescription className="sr-only">Preview media and use the arrow keys to browse.</DialogDescription>

        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="absolute right-5 top-5 rounded-full text-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={(event) => event.stopPropagation()}
            aria-label="Close preview"
          >
            <CloseOutlined />
          </Button>
        </DialogClose>

        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="absolute right-5 top-[68px] rounded-full text-foreground hover:bg-foreground/10 hover:text-foreground"
          onClick={(event) => { event.stopPropagation(); handleDownload(); }}
          aria-label="Download media"
        >
          <DownloadOutlined />
        </Button>

        {count > 1 && (
          <div className="absolute left-5 top-1/2 -translate-y-1/2">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="rounded-full text-foreground hover:bg-foreground/10 hover:text-foreground"
              onClick={(event) => { event.stopPropagation(); go(-1); }}
              aria-label="Previous media"
            >
              <LeftOutlined />
            </Button>
          </div>
        )}

        {current?.url && (
          current.mediaType === "video" ? (
            <VideoPlayer
              key={current.url}
              src={current.url}
              className="shadow-[0_8px_40px_rgb(0_0_0_/_50%)]"
            />
          ) : (
            <img
              src={current.url}
              alt=""
              draggable={false}
              onClick={(event) => event.stopPropagation()}
              className="block max-h-[88vh] max-w-[90vw] rounded-lg object-contain shadow-[0_8px_40px_rgb(0_0_0_/_50%)]"
            />
          )
        )}

        {count > 1 && (
          <div className="absolute right-5 top-1/2 -translate-y-1/2">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="rounded-full text-foreground hover:bg-foreground/10 hover:text-foreground"
              onClick={(event) => { event.stopPropagation(); go(1); }}
              aria-label="Next media"
            >
              <RightOutlined />
            </Button>
          </div>
        )}

        {count > 1 && (
          <div
            className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-card/70 px-3 py-1 text-sm text-foreground/90"
            onClick={(event) => event.stopPropagation()}
          >
            {safeIndex + 1} / {count}
          </div>
        )}

        {count > 1 && (
          <div
            className="absolute bottom-14 left-1/2 flex max-w-[90vw] -translate-x-1/2 gap-2 overflow-x-auto rounded-xl bg-card/70 p-2"
            onClick={(event) => event.stopPropagation()}
          >
            {items.map((item, itemIndex) => (
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                key={`${item.url}-${itemIndex}`}
                onClick={(event) => { event.stopPropagation(); onIndexChange?.(itemIndex); }}
                className={`size-14 shrink-0 overflow-hidden rounded-md p-0 transition ${
                    itemIndex === safeIndex ? "ring-2 ring-foreground" : "opacity-60 hover:opacity-100"
                }`}
              >
                {item.mediaType === "video" ? (
                  <video src={item.url} muted preload="metadata" className="h-full w-full object-cover" />
                ) : (
                  <img src={item.url} alt="" className="h-full w-full object-cover" draggable={false} />
                )}
              </Button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
