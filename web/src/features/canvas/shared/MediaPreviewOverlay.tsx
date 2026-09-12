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

import { CloseOutlined,DownloadOutlined, LeftOutlined,RightOutlined } from "@ant-design/icons";
import { useEffect,useState } from "react";

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

  const btnBase =
    "flex cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:text-white hover:bg-white/15";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center nodrag"
      style={{
        background: "rgba(0,0,0,0.92)",
        opacity: shown ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
      onClick={onClose}
    >
      {/* 关闭 */}
      <button
        className={`${btnBase} absolute right-5 top-5 h-10 w-10 text-xl`}
        onClick={onClose}
      >
        <CloseOutlined />
      </button>

      {/* 下载 */}
      <button
        className={`${btnBase} absolute right-5 top-[68px] h-10 w-10 text-lg`}
        onClick={(e) => { e.stopPropagation(); handleDownload(); }}
      >
        <DownloadOutlined />
      </button>

      {/* 上一张 */}
      {count > 1 && (
        <button
          className={`${btnBase} absolute left-5 top-1/2 h-12 w-12 -translate-y-1/2 text-2xl`}
          onClick={(e) => { e.stopPropagation(); go(-1); }}
        >
          <LeftOutlined />
        </button>
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
        <button
          className={`${btnBase} absolute right-5 top-1/2 h-12 w-12 -translate-y-1/2 text-2xl`}
          onClick={(e) => { e.stopPropagation(); go(1); }}
        >
          <RightOutlined />
        </button>
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
            <button
              key={i}
              onClick={() => onIndexChange?.(i)}
              className={`h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-md transition ${
                i === safeIndex ? "ring-2 ring-white" : "opacity-60 hover:opacity-100"
              }`}
            >
              {item.mediaType === "video" ? (
                // 静音 + preload=metadata：只解首帧当封面，不预载全片
                <video src={item.url} muted preload="metadata" className="h-full w-full object-cover" />
              ) : (
                <img src={item.url} alt="" className="h-full w-full object-cover" draggable={false} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
