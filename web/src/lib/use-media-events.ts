/**
 * 媒体元素事件订阅（specs/canvas-audio-peaks-cache.md 规则 4.5 / 5.2）。
 *
 * 节点波形与截取面板的播放事件订阅（事件 → 状态的映射由
 * `useMediaPlaybackMirror` 共用）；两处的 add / remove 形状逐行相同，差别只在
 * 回调做什么，订阅语义（只挂一次、回调取最新一次渲染的闭包）集中在这里。
 *
 * 回调放在 ref 里：调用方的回调通常闭包了时长、选区等会变的输入，按依赖
 * 重新订阅会在播放中反复摘挂监听。事件到达时读 ref，拿到的总是最新闭包。
 */
"use client";

import { type RefObject, useEffect, useRef } from "react";

/** 音频播放关心的元素事件；回调无参数，需要值时自行从元素读取 */
export type MediaEventType = "play" | "pause" | "ended" | "timeupdate" | "loadedmetadata";

const MEDIA_EVENTS: readonly MediaEventType[] = [
  "play",
  "pause",
  "ended",
  "timeupdate",
  "loadedmetadata",
];

export function useMediaEvents(
  mediaRef: RefObject<HTMLMediaElement | null>,
  handlers: Partial<Record<MediaEventType, () => void>>,
): void {
  const handlersRef = useRef(handlers);
  // 先于订阅 effect 声明：挂载时 ref 已是本次渲染的回调，之后每次渲染刷新
  useEffect(() => {
    handlersRef.current = handlers;
  });
  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    // 五个事件全部订阅：调用方没给回调的事件只是空转一次，换来「回调出现/消失
    // 不需要重新订阅」——否则条件回调会让订阅表随渲染变化
    const listeners = MEDIA_EVENTS.map((type) => {
      const listener = () => handlersRef.current[type]?.();
      element.addEventListener(type, listener);
      return [type, listener] as const;
    });
    return () => {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
    };
  }, [mediaRef]);
}
