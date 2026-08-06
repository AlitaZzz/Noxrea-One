/**
 * 资产悬浮大图预览。
 * 导出状态 hook（含进入 / 离开延迟与定位计算）与配套的 Portal 展示组件，
 * 供侧边栏、资产库等缩略图列表复用。
 */
"use client";

import { type MouseEvent,useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AssetItem } from "@/features/assets/types";

const PREVIEW_W = 400;
const PREVIEW_MAX_H = 340;
const SHOW_DELAY = 600;
const HIDE_DELAY = 150;
const GAP = 12;

interface PreviewState {
  visible: boolean;
  asset: AssetItem | null;
  x: number;
  y: number;
}

/**
 * 管理资产缩略图 hover 时的大图预览状态。
 * - 进入延迟 200ms 显示，离开 150ms 隐藏（避免划过闪现）
 * - 位置在 onEnter 时基于 anchorX（容器右边界）与卡片顶部确定一次，不跟随鼠标
 *
 * @param anchorX 预览应出现在其右侧的容器右边界 x（如左侧 Drawer 的右缘），
 *               保证大图显示在容器之外、不遮挡容器内部。
 */
export function useAssetHoverPreview(anchorX = 0) {
  const [state, setState] = useState<PreviewState>({
    visible: false,
    asset: null,
    x: 0,
    y: 0,
  });
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const onEnter = useCallback(
    (asset: AssetItem, e: MouseEvent) => {
      // 音频无可视缩略图，不触发预览
      if (asset.mediaType === "audio") return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // 水平锚定在容器右边界之外，垂直对齐卡片顶部；只计算一次，不跟随鼠标
      setState({
        asset,
        x: anchorX + GAP,
        y: rect.top,
        visible: false,
      });
      if (showTimer.current) clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        setState((s) => ({ ...s, visible: true }));
      }, SHOW_DELAY);
    },
    [anchorX]
  );

  const onLeave = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => {
      setState((s) => ({ ...s, visible: false }));
    }, HIDE_DELAY);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  return { ...state, onEnter, onLeave };
}

/** 浮在 body 上的大图预览（视频显示封面，不自动播放），显示在容器右边界之外。 */
export function AssetHoverPreview({
  asset,
  visible,
  x,
  y,
}: {
  asset: AssetItem | null;
  visible: boolean;
  x: number;
  y: number;
}) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  if (!visible || !asset) return null;

  const sourceUrl = asset.metadata?.sourceUrl as string | undefined;
  const coverUrl = asset.metadata?.coverUrl as string | undefined;
  const isVideo = asset.mediaType === "video";
  const isAudio = asset.mediaType === "audio";

  // 音频无可视缩略图，不展示大图预览
  if (isAudio) return null;

  const bigUrl = isVideo
    ? coverUrl
      ? coverUrl.includes("/api/files/") ? `${coverUrl}?w=400` : coverUrl
      : null
    : sourceUrl
      ? sourceUrl.includes("/api/files/") ? `${sourceUrl}?w=400` : sourceUrl
      : null;

  if (!isVideo && !bigUrl) return null;

  // 固定位置（不跟随鼠标）：水平已锚定在容器右边界外，仅做视口边界约束
  let left = x;
  let top = y;
  if (typeof window !== "undefined") {
    // 若右侧空间不足则翻到左侧（小屏场景）
    if (left + PREVIEW_W > window.innerWidth) left = x - PREVIEW_W - GAP * 2;
    // 用图片实际显示高度（onLoad 后）约束；加载前用 70vh 兜底，避免竖图超出底部
    const usedH = box ? box.h : window.innerHeight * 0.7;
    if (top + usedH > window.innerHeight) top = window.innerHeight - usedH - 8;
    if (top < 8) top = 8;
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 9999,
        pointerEvents: "none",
        width: box ? box.w : PREVIEW_W,
        maxHeight: box ? box.h : "70vh",
        borderRadius: 12,
        overflow: "hidden",
        background: "#000",
        border: "1px solid var(--canvas-border)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
      }}
    >
      {isVideo ? (
        <video
          src={sourceUrl}
          poster={bigUrl || undefined}
          autoPlay
          muted
          loop
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            const nw = v.videoWidth;
            const nh = v.videoHeight;
            if (!nw || !nh) return;
            let w: number, h: number;
            if (nw >= nh) {
              h = PREVIEW_MAX_H;
              w = h * (nw / nh);
            } else {
              w = PREVIEW_W;
              h = w * (nh / nw);
            }
            const maxH = window.innerHeight * 0.7;
            if (h > maxH) {
              h = maxH;
              w = h * (nw / nh);
            }
            setBox({ w, h });
          }}
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#000" }}
        />
      ) : (
        <img
          src={bigUrl || undefined}
          alt={asset.name}
          onLoad={(e) => {
            const img = e.currentTarget;
            const nw = img.naturalWidth;
            const nh = img.naturalHeight;
            if (!nw || !nh) return;
            // 横图以高度为基准，竖图以宽度为基准
            let w: number, h: number;
            if (nw >= nh) {
              // Landscape / square: base on height
              h = PREVIEW_MAX_H;
              w = h * (nw / nh);
            } else {
              // Portrait: base on width
              w = PREVIEW_W;
              h = w * (nh / nw);
            }
            const maxH = window.innerHeight * 0.7;
            if (h > maxH) {
              h = maxH;
              w = h * (nw / nh);
            }
            setBox({ w, h });
          }}
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
        />
      )}
    </div>,
    document.body
  );
}
