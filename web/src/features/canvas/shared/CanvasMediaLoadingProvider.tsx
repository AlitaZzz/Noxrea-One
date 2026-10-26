"use client";

import { useStoreApi } from "@xyflow/react";
import { createContext, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { ImageLoadScheduler } from "@/features/canvas/services/image-load-scheduler";
import { LOD_SETTLE_MS } from "@/features/canvas/shared/image-lod";
import { getLiveViewport } from "@/features/canvas/stores/canvas-store";
import { DEFAULT_VIEWPORT } from "@/lib/constants";

export const CanvasImageLoadingContext = createContext<ImageLoadScheduler | null>(null);

const MIN_DPR = 1;
const MAX_DPR = 3;

export type CanvasMediaViewport = {
  /** 结算后的缩放：手势进行中保持不变，停止 200ms 后更新 */
  settledZoom: number;
  /** 有效 DPR（clamp 1..3） */
  dpr: number;
  /** 是否处于缩小手势：只在方向变化时翻转，结算后归 false；不逐帧更新 */
  zoomingOut: boolean;
};

/**
 * 画布媒体视口上下文：LOD 换档只需要结算后的缩放、DPR 与缩小方向，
 * 实时 zoom 不进 context（否则全树逐帧渲染）；缩小中止由 LOD hook 自订阅 store。
 */
export const CanvasMediaViewportContext = createContext<CanvasMediaViewport>({
  settledZoom: DEFAULT_VIEWPORT.zoom,
  dpr: MIN_DPR,
  zoomingOut: false,
});

function effectiveDpr(): number {
  if (typeof window === "undefined") return MIN_DPR;
  const raw = window.devicePixelRatio;
  return Number.isFinite(raw) ? Math.min(MAX_DPR, Math.max(MIN_DPR, raw)) : MIN_DPR;
}

/** DPR 外部源订阅：resize 兜底 + 当前分辨率媒体查询（DPR 变化后媒体查询失配，回调内重建） */
function subscribeDpr(onChange: () => void): () => void {
  let media: MediaQueryList | null = null;
  const watch = () => {
    media?.removeEventListener("change", handle);
    media = window.matchMedia?.(`(resolution: ${effectiveDpr()}dppx)`) ?? null;
    media?.addEventListener("change", handle);
  };
  const handle = () => {
    watch();
    onChange();
  };
  watch();
  window.addEventListener("resize", handle);
  return () => {
    media?.removeEventListener("change", handle);
    window.removeEventListener("resize", handle);
  };
}

// 视频不再走调度器（poster-first：静止态是海报图片，播放/编辑用临时会话元素，
// 见 specs/canvas-video-poster-first.md），此处承载图片加载调度与 LOD 视口结算。
export default function CanvasMediaLoadingProvider({ children }: { children: ReactNode }) {
  const [images] = useState(() => new ImageLoadScheduler());
  useEffect(() => () => { images.clear(); }, [images]);

  const store = useStoreApi();
  // 初始值取恢复后的视口，避免先按默认 1.0 请求一轮再切到 0.1
  const [settledZoom, setSettledZoom] = useState(() => getLiveViewport().zoom || DEFAULT_VIEWPORT.zoom);
  const [zoomingOut, setZoomingOut] = useState(false);
  // SSR 快照固定 1（无 window），客户端用真实 DPR：外部源订阅避免 effect 内 setState 级联渲染
  const dpr = useSyncExternalStore(subscribeDpr, effectiveDpr, () => MIN_DPR);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      timer = null;
      setZoomingOut(false);
      setSettledZoom(store.getState().transform[2]);
    };

    const unsubscribe = store.subscribe((state, previous) => {
      const zoom = state.transform[2];
      if (zoom === previous.transform[2]) return;
      // 方向取相邻两帧的缩放：同一手势内反向（放大后回缩、缩小后回放）也必须翻转，
      // 规则 3.9 的在途中止据此生效。值未变化时 setState 直接跳过，不逐帧渲染。
      setZoomingOut(zoom < previous.transform[2]);
      if (timer) clearTimeout(timer);
      // 缩放手势停止该时长后换档（specs/canvas-media-resolution-lod.md 规则 5.1）；
      // 与节点尺寸结算共用同一常量（image-lod 的 LOD_SETTLE_MS）
      timer = setTimeout(settle, LOD_SETTLE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [store]);

  return (
    <CanvasImageLoadingContext.Provider value={images}>
      <CanvasMediaViewportContext.Provider value={{ settledZoom, dpr, zoomingOut }}>
        {children}
      </CanvasMediaViewportContext.Provider>
    </CanvasImageLoadingContext.Provider>
  );
}
