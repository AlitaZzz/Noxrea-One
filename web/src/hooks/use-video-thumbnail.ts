"use client";

import { useEffect, useState } from "react";

/** 模块级全局缓存：跨组件实例与 tab 切换复用，避免重复解码视频 */
const videoThumbCache = new Map<string, string>();

/** 从视频 URL 提取第一帧缩略图（带模块级缓存） */
export function useVideoThumbnail(src: string | undefined) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!src) return;
    const cached = videoThumbCache.get(src);
    if (cached) { setThumb(cached); return; }
    let cancelled = false;
    setLoading(true);
    setThumb(null);

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
