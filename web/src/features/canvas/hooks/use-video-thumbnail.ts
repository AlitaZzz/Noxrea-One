/**
 * 视频首帧缩略图提取 hook，带模块级缓存避免重复解码。
 */
"use client";

import { useEffect, useState } from "react";

/** 模块级全局缓存：跨组件实例与 tab 切换复用，避免重复解码视频 */
const videoThumbCache = new Map<string, string>();

/** 缓存条目上限，超出时按 FIFO 淘汰最旧条目（40 条 × ~1.5MB ≈ 60MB） */
const MAX_VIDEO_THUMB_CACHE = 40;

/** 从视频 URL 提取第一帧缩略图（带模块级缓存） */
export function useVideoThumbnail(src: string | undefined) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!src) return;
    const cached = videoThumbCache.get(src);
    if (cached) {
      // 缓存命中：仅在下一 tick 写入 state，避免在 effect 内同步 setState 引发级联渲染
      queueMicrotask(() => setThumb(cached));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => { setLoading(true); setThumb(null); });

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = src;

    const onSeek = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        const url = canvas.toDataURL("image/jpeg", 0.6);
        // FIFO 淘汰：超出上限时删除最早插入的条目
        if (videoThumbCache.size >= MAX_VIDEO_THUMB_CACHE) {
          const oldest = videoThumbCache.keys().next().value;
          if (oldest !== undefined) videoThumbCache.delete(oldest);
        }
        videoThumbCache.set(src, url);
        setThumb(url);
      } catch { /* noop */ }
      setLoading(false);
      video.remove();
    };
    const onMeta = () => { video.currentTime = 1; };
    const onErr = () => { if (!cancelled) { setLoading(false); video.remove(); } };

    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("seeked", onSeek);
    video.addEventListener("error", onErr);

    return () => { cancelled = true; video.remove(); };
  }, [src]);

  return { thumb, loading };
}
