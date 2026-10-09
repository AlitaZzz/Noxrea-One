"use client";

import { createContext, type ReactNode, useEffect, useState } from "react";

import { ImageLoadScheduler } from "@/features/canvas/services/image-load-scheduler";
import { VideoLoadScheduler } from "@/features/canvas/services/video-load-scheduler";

export const CanvasImageLoadingContext = createContext<ImageLoadScheduler | null>(null);
export const CanvasVideoLoadingContext = createContext<VideoLoadScheduler | null>(null);

export default function CanvasMediaLoadingProvider({ children }: { children: ReactNode }) {
  const [images] = useState(() => new ImageLoadScheduler());
  const [videos] = useState(() => new VideoLoadScheduler());
  useEffect(() => () => { images.clear(); videos.clear(); }, [images, videos]);
  return (
    <CanvasImageLoadingContext.Provider value={images}>
      <CanvasVideoLoadingContext.Provider value={videos}>{children}</CanvasVideoLoadingContext.Provider>
    </CanvasImageLoadingContext.Provider>
  );
}
