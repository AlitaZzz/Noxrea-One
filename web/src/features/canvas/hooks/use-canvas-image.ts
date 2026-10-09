"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { useCanvasMediaPriority } from "@/features/canvas/hooks/use-canvas-media-priority";
import type { ImageLoadLease, ImageLoadResult } from "@/features/canvas/services/image-load-scheduler";
import { CanvasImageLoadingContext } from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";

export function useCanvasImage(nodeId: string, src: string, placement: ImagePlacement) {
  const scheduler = useContext(CanvasImageLoadingContext);
  if (!scheduler) throw new Error("Canvas images require a loading provider");
  const priority = useCanvasMediaPriority(nodeId, placement);
  const leaseRef = useRef<ImageLoadLease | null>(null);
  const [loaded, setLoaded] = useState<{ src: string; scheduler: typeof scheduler; result: ImageLoadResult } | null>(null);

  useEffect(() => {
    if (!src) return;
    let current = true;
    const lease = scheduler.acquire(src, (result) => {
      if (current) setLoaded({ src, scheduler, result });
    });
    leaseRef.current = lease;
    return () => {
      current = false;
      lease.release();
      leaseRef.current = null;
    };
  }, [scheduler, src]);

  useEffect(() => { leaseRef.current?.setPriority(priority); }, [scheduler, src, priority]);

  const retry = useCallback(() => leaseRef.current?.retry(), []);
  const result = loaded?.src === src && loaded.scheduler === scheduler ? loaded.result : null;
  return { result, retry };
}
