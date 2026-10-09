"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { useCanvasMediaPriority } from "@/features/canvas/hooks/use-canvas-media-priority";
import type { VideoLoadLease, VideoLoadStatus } from "@/features/canvas/services/video-load-scheduler";
import { VIDEO_INTERACTION_PRIORITY } from "@/features/canvas/services/video-load-scheduler";
import { CanvasVideoLoadingContext } from "@/features/canvas/shared/CanvasMediaLoadingProvider";

type LoadDemand = { lease: VideoLoadLease; priority: Parameters<VideoLoadLease["setPriority"]>[0]; demands: Set<symbol> };
function applyPriority(current: LoadDemand) {
  current.lease.setPriority(current.demands.size ? VIDEO_INTERACTION_PRIORITY : current.priority);
}

export function useCanvasVideo(nodeId: string, src: string, active: boolean) {
  const scheduler = useContext(CanvasVideoLoadingContext);
  if (!scheduler) throw new Error("Canvas videos require a loading provider");
  const viewportPriority = useCanvasMediaPriority(nodeId);
  const priority = active ? VIDEO_INTERACTION_PRIORITY : viewportPriority;
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const leaseRef = useRef<LoadDemand | null>(null);
  const [loaded, setLoaded] = useState<{ src: string; element: HTMLVideoElement; scheduler: typeof scheduler; status: VideoLoadStatus } | null>(null);

  useEffect(() => {
    if (!element || !src) return;
    let current = true;
    const lease = scheduler.acquire(element, src, (status) => {
      if (current) setLoaded((prev) => prev?.src === src && prev.element === element && prev.scheduler === scheduler && prev.status === status ? prev : { src, element, scheduler, status });
    });
    leaseRef.current = { lease, priority: null, demands: new Set() };
    return () => {
      current = false;
      lease.release();
      leaseRef.current = null;
    };
  }, [element, scheduler, src]);

  useEffect(() => {
    const current = leaseRef.current;
    if (!current) return;
    current.priority = priority;
    applyPriority(current);
  }, [element, scheduler, src, priority]);
  const requestLoad = useCallback(() => {
    const current = leaseRef.current;
    if (!current) return () => {};
    const demand = Symbol();
    current.demands.add(demand);
    applyPriority(current);
    return () => {
      if (leaseRef.current !== current || !current.demands.delete(demand)) return;
      applyPriority(current);
    };
  }, []);
  const retry = useCallback(() => leaseRef.current?.lease.retry(), []);
  const status = loaded?.src === src && loaded.element === element && loaded.scheduler === scheduler ? loaded.status : "idle";
  return { setElement, requestLoad, retry, status };
}
