"use client";

import { useCallback, useEffect, useState } from "react";

type VideoSessionStatus = "idle" | "loading" | "ready" | "failed";

/**
 * 视频会话元素状态 hook（poster-first 架构）。
 * <video> 仅在会话激活（播放 / 编辑面板 / 忙状态）时由 VideoNode 条件渲染挂载，
 * 本 hook 登记元素并跟踪其加载状态，供裁剪面板就绪门控与失败重试遮罩消费。
 *
 * 状态判定只认「元素当前 src === 会话 src」：帧序列面板打开期间播放器会被
 * swapVideoSource 临时切到代理视频，代理的错误不得计入会话状态。
 * 就绪度由可重复触发的 loadeddata/canplay 驱动——数据被浏览器逐出后再次就绪
 * 时状态自愈；初值与换源重挂由 ref 回调按真实 readyState 归位（src 变化会
 * 连带 key 重挂），失败不粘滞，没有一次性定时器下永久结论。
 */
export function useCanvasVideo(src: string, active: boolean) {
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<VideoSessionStatus>("idle");

  useEffect(() => {
    const video = element;
    if (!video || !active || !src) return;
    let current = true;
    const isOwnSource = () => video.getAttribute("src") === src;
    const onReady = () => { if (current && isOwnSource()) setStatus("ready"); };
    const onError = () => { if (current && isOwnSource()) setStatus("failed"); };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
    return () => {
      current = false;
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
  }, [element, src, active]);

  const setVideoElement = useCallback((el: HTMLVideoElement | null) => {
    setElement(el);
    setStatus(el ? (el.readyState >= 2 ? "ready" : "loading") : "idle");
  }, []);

  return { element, setElement: setVideoElement, status };
}
