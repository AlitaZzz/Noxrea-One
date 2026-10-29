/**
 * 媒体元素事件 → 播放镜像（specs/canvas-audio-peaks-cache.md 规则 4.5 / 4.6）。
 *
 * 节点波形与截取面板都要把 `<audio>` 的 play / pause / ended / timeupdate /
 * loadedmetadata 映射成同一组状态：是否在播放、当前位置、媒体时长。哪个事件改
 * 哪个字段、什么算有效时长、换源后作废，是同一条规则，只写在这里；面板额外的
 * 循环约束与结束续播通过 `extras` 在镜像的 patch 之后执行（同一事件处理内、
 * 重渲染之前；附加回调需要的是事件时机，不是更新后的镜像值）。
 *
 * 逐帧进度（`useMediaProgress`）与 `timeupdate` 写的是同一个 progress 维度：
 * 回写入口也由这里统一提供（`reportProgress`），调用方不再各包一层 `patch`。
 *
 * 镜像按身份记账（`useElementMirror`）：身份一变立即回到初始值，与视频节点的
 * 换源作废语义一致。`initial` 必须是稳定引用（模块级常量）。
 */
"use client";

import { type RefObject, useCallback } from "react";

import { useElementMirror } from "@/lib/use-element-mirror";
import { type MediaEventType, useMediaEvents } from "@/lib/use-media-events";

/** 播放镜像：渲染播放按钮、进度与时长所需的三个维度 */
export interface MediaPlaybackMirror {
  playing: boolean;
  /** 当前播放位置（秒） */
  progress: number;
  /** 媒体总时长（秒）；元数据未就绪或无效时为 0 */
  duration: number;
}

export interface MediaPlaybackMirrorHandle {
  /** 当前镜像；身份变化后立即回到初始值 */
  mirror: MediaPlaybackMirror;
  /** 字段级更新（事件与调用方共用） */
  patch: (next: Partial<MediaPlaybackMirror>) => void;
  /** 逐帧进度回写：与 `timeupdate` 写同一个 progress 维度，交给 `useMediaProgress` */
  reportProgress: (time: number) => void;
}

export function useMediaPlaybackMirror(
  mediaRef: RefObject<HTMLMediaElement | null>,
  identity: string,
  initial: MediaPlaybackMirror,
  extras?: Partial<Record<MediaEventType, () => void>>,
): MediaPlaybackMirrorHandle {
  const [mirror, patch] = useElementMirror<MediaPlaybackMirror>(identity, initial);
  // `patch` 只随身份与初始值变化，回写函数因此同样稳定
  const reportProgress = useCallback((time: number) => {
    patch({ progress: time });
  }, [patch]);

  useMediaEvents(mediaRef, {
    // 起播时同步一次位置：暂停期间 currentTime 可能被外部（拖动、选区初始化）改写
    play: () => {
      patch({ playing: true, progress: mediaRef.current?.currentTime ?? 0 });
      extras?.play?.();
    },
    pause: () => {
      patch({ playing: false });
      extras?.pause?.();
    },
    // 播完不是 pause：ended 后 paused 未必置位，镜像必须由这个事件收尾
    ended: () => {
      patch({ playing: false });
      extras?.ended?.();
    },
    timeupdate: () => {
      patch({ progress: mediaRef.current?.currentTime ?? 0 });
      extras?.timeupdate?.();
    },
    // 非有限时长（NaN / Infinity）与 0 都不覆盖已知时长：元数据这次没给出可用值
    loadedmetadata: () => {
      const loaded = mediaRef.current?.duration ?? 0;
      if (Number.isFinite(loaded) && loaded > 0) patch({ duration: loaded });
      extras?.loadedmetadata?.();
    },
  });

  return { mirror, patch, reportProgress };
}
