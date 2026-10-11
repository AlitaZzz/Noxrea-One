"use client";

import { createContext, type ReactNode, useEffect, useState } from "react";

import { ImageLoadScheduler } from "@/features/canvas/services/image-load-scheduler";

export const CanvasImageLoadingContext = createContext<ImageLoadScheduler | null>(null);

// 视频不再走调度器（poster-first：静止态是海报图片，播放/编辑用临时会话元素，
// 见 specs/canvas-video-poster-first.md），此处只承载图片加载调度。
export default function CanvasMediaLoadingProvider({ children }: { children: ReactNode }) {
  const [images] = useState(() => new ImageLoadScheduler());
  useEffect(() => () => { images.clear(); }, [images]);
  return (
    <CanvasImageLoadingContext.Provider value={images}>{children}</CanvasImageLoadingContext.Provider>
  );
}
