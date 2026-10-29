/**
 * 视频播放位置的时间源（供 `useMediaProgress` 作为读取函数）。
 *
 * 读取函数的身份必须稳定：`useMediaProgress` 把身份变化视为换源并重启循环，
 * 内联箭头函数会让每次渲染都重启。身份只随节点变化，两个视频编辑面板共用这一处。
 */
"use client";

import { useCallback } from "react";

import { getVideoPlaybackTime } from "@/features/canvas/shared/video-playback-registry";

export function useVideoTimeSource(nodeId: string): () => number {
  return useCallback(() => getVideoPlaybackTime(nodeId), [nodeId]);
}
