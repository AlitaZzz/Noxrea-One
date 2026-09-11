/**
 * 延迟悬停态。
 *
 * 参考卡的悬停预览（图片放大、视频浮层）若立即响应，鼠标扫过一排卡片时会连续闪出
 * 大块浮层；这里让「进入」延迟 delay 毫秒才置为 true，而「离开」立即复位并取消未触发的
 * 定时器，从而只对真正的停留作出响应。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DelayedHover {
  /** 停留超过 delay 后才为 true */
  active: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useDelayedHover(delay = 150): DelayedHover {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onMouseEnter = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setActive(true);
    }, delay);
  }, [clearTimer, delay]);

  const onMouseLeave = useCallback(() => {
    clearTimer();
    setActive(false);
  }, [clearTimer]);

  // 卸载时清掉未触发的定时器，避免对已卸载组件 setState
  useEffect(() => clearTimer, [clearTimer]);

  return { active, onMouseEnter, onMouseLeave };
}
