/**
 * 播放进度逐帧跟随（节点波形、音频截取面板与视频编辑面板共用）。
 *
 * `timeupdate` 只有约 4Hz，播放中的进度竖线若只靠它会在视觉上跳步；活跃期间用
 * rAF 读取时间源，变化超过阈值才回调，静止时不产生渲染。`onFrame` 每帧都会收到
 * 当前时间，供需要逐帧判定的逻辑（截取面板的循环约束）复用同一个循环。
 *
 * 时间源以读取函数注入：音频读自己的媒体元素，视频面板读播放注册表（元素不在
 * 面板手里）。`readTime` 必须身份稳定（调用方 `useCallback`），且参与 effect
 * 依赖——身份变化即换源，循环以新源的当前值重启。返回 `null` 表示源尚未就绪，
 * 不启动循环。
 */
"use client";

import { useEffect, useRef } from "react";

/** 进度去重阈值（秒）：小于一次可感知的推进，不触发重渲染 */
const PROGRESS_EPSILON = 0.003;

export function useMediaProgress(
  readTime: () => number | null,
  active: boolean,
  onProgress: (currentTime: number) => void,
  onFrame?: (currentTime: number) => void,
): void {
  // 回调身份不参与循环生命周期：调用方每次渲染重建回调也不会重启 rAF
  const callbacksRef = useRef({ onProgress, onFrame });
  useEffect(() => {
    callbacksRef.current = { onProgress, onFrame };
  }, [onProgress, onFrame]);

  useEffect(() => {
    if (!active) return;
    const start = readTime();
    if (start === null) return;
    let raf = 0;
    let last = start;
    const tick = () => {
      const now = readTime();
      // 源中途不可读（元素被替换等）时本帧跳过，循环保留：源恢复后自然继续
      if (now !== null) {
        const callbacks = callbacksRef.current;
        if (Math.abs(now - last) > PROGRESS_EPSILON) {
          last = now;
          callbacks.onProgress(now);
        }
        // 进度回调之后执行：循环约束可能改写 currentTime，下一帧自然收敛到新位置
        callbacks.onFrame?.(now);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [readTime, active]);
}
