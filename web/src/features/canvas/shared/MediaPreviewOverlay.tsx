/**
 * 全屏媒体预览浮层：图片 / 视频共用。
 *
 * 图片：支持多图切换（左右箭头 / 缩略图条 / 计数）、下载、Esc 或点击背景关闭。
 * 视频：渲染原生播放器（自带 controls），同样支持下载与关闭。
 *
 * 原先是 ImageNode 内部的 PreviewOverlay，为让视频节点工具栏也能挂「预览」而抽出，
 * 保证两类节点的预览外观与交互完全一致。
 */
"use client";

import { useEffect, useState } from "react";

import { CloseOutlined, DownloadOutlined, LeftOutlined, RightOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";

import VideoPlayer from "./VideoPlayer";

export interface PreviewItem {
  url: string;
  mediaType: "image" | "video";
}

interface Props {
  items: PreviewItem[];
  index: number;
  /** 单张预览（如视频）可不传 */
  onIndexChange?: (i: number) => void;
  onClose: () => void;
}

export default function MediaPreviewOverlay({ items, index, onIndexChange, onClose }: Props) {
  const [shown, setShown] = useState(false);
  const count = items.length;
  // index 可能与 items 不同步（多图结果被替换后列表变短等），统一 clamp 后再使用
  const safeIndex = Math.max(0, Math.min(index, count - 1));
  const current = items[safeIndex];
  const go = (dir: number) => {
    if (count <= 1) return;
    onIndexChange?.((safeIndex + dir + count) % count);
  };
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const handleDownload = () => {
    if (!current?.url) return;
    const a = document.createElement("a");
    const sep = current.url.includes("?") ? "&" : "?";
    a.href = `${current.url}${sep}${new URLSearchParams({ download: "true" }).toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 transition-opacity duration-200 nodrag ${shown ? "opacity-100" : "opacity-0"}`}
      onClick={onClose}
    >
      {/* 关闭 */}
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="absolute right-5 top-5 rounded-full text-white hover:bg-white/15 hover:text-white"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close preview"
      >
        <CloseOutlined />
      </Button>

      {/* 下载 */}
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="absolute right-5 top-[68px] rounded-full text-white hover:bg-white/15 hover:text-white"
        onClick={(e) => { e.stopPropagation(); handleDownload(); }}
        aria-label="Download media"
      >
        <DownloadOutlined />
      </Button>

      {/* 上一张 */}
      {count > 1 && (
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="absolute left-5 top-1/2 -translate-y-1/2 rounded-full text-white hover:bg-white/15 hover:text-white"
          onClick={(e) => { e.stopPropagation(); go(-1); }}
          aria-label="Previous media"
        >
          <LeftOutlined />
        </Button>
      )}

      {/* 当前媒体 */}
      {current?.url && (
        current.mediaType === "video" ? (
          <VideoPlayer
            key={current.url}
            src={current.url}
            style={{
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
              transform: shown ? "scale(1)" : "scale(0.96)",
              transition: "transform 0.2s ease",
            }}
          />
        ) : (
          <img
            src={current.url}
            alt=""
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "90vw",
              maxHeight: "88vh",
              objectFit: "contain",
              borderRadius: 8,
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
              transform: shown ? "scale(1)" : "scale(0.96)",
              transition: "transform 0.2s ease",
            }}
          />
        )
      )}

      {/* 下一张 */}
      {count > 1 && (
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="absolute right-5 top-1/2 -translate-y-1/2 rounded-full text-white hover:bg-white/15 hover:text-white"
          onClick={(e) => { e.stopPropagation(); go(1); }}
          aria-label="Next media"
        >
          <RightOutlined />
        </Button>
      )}

      {/* 计数 */}
      {count > 1 && (
        <div
          className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-sm text-white/90"
          onClick={(e) => e.stopPropagation()}
        >
          {safeIndex + 1} / {count}
        </div>
      )}

      {/* 缩略图条 */}
      {count > 1 && (
        <div
          className="absolute bottom-14 left-1/2 flex max-w-[90vw] -translate-x-1/2 gap-2 overflow-x-auto rounded-xl bg-black/40 p-2"
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item, i) => (
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              key={i}
              onClick={(e) => { e.stopPropagation(); onIndexChange?.(i); }}
              className={`size-14 shrink-0 overflow-hidden rounded-md p-0 transition ${
                i === safeIndex ? "ring-2 ring-white" : "opacity-60 hover:opacity-100"
              }`}
            >
              {item.mediaType === "video" ? (
                // 静音 + preload=metadata：只解首帧当封面，不预载全片
                <video src={item.url} muted preload="metadata" className="h-full w-full object-cover" />
              ) : (
                <img src={item.url} alt="" className="h-full w-full object-cover" draggable={false} />
              )}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
