"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { useCanvasMediaPriority } from "@/features/canvas/hooks/use-canvas-media-priority";
import type { ImageLoadLease, ImageLoadResult } from "@/features/canvas/services/image-load-scheduler";
import { CanvasImageLoadingContext } from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";

type Options = {
  /** 解码任务重量（specs/canvas-media-resolution-lod.md 规则 7）；缺省 1 */
  weight?: number;
  /** 为真时把 lease 优先级置 null，中止在途 job（缩小时中止高档位）；已就绪结果不受影响 */
  suspend?: boolean;
};

/**
 * `src` 为 undefined = 访问地址尚未解析完成：不申请调度任务，调用方渲染占位。
 * 不用空串当哨兵——调度器的 URL 是任务身份，空串不是合法身份。
 */
export function useCanvasImage(nodeId: string, src: string | undefined, placement: ImagePlacement, options: Options = {}) {
  const { weight = 1, suspend = false } = options;
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

  useEffect(() => {
    leaseRef.current?.setPriority(suspend ? null : priority);
  }, [scheduler, src, priority, suspend]);

  useEffect(() => { leaseRef.current?.setWeight(weight); }, [scheduler, src, weight]);

  const retry = useCallback(() => leaseRef.current?.retry(), []);
  const result = loaded && loaded.src === src && loaded.scheduler === scheduler ? loaded.result : null;
  return { result, retry };
}
