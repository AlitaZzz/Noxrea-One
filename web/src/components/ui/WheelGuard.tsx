/**
 * 滚轮事件隔离容器。
 * 用原生监听拦截 wheel 事件，避免画布内浮层滚动时误触 React Flow 缩放。
 */
"use client";

import { type ComponentPropsWithoutRef, useEffect, useRef } from "react";

/**
 * 包裹需要阻止 wheel 事件冒泡到 React Flow 的 UI 区域。
 *
 * React Flow 使用原生 addEventListener 监听 wheel 实现画布缩放，
 * React 合成事件的 e.stopPropagation() 无法阻止原生 DOM 冒泡。
 * WheelGuard 用原生 addEventListener 在目标元素拦截 wheel 事件，
 * 阻止其到达 React Flow 的 zoom 处理器。
 */
export default function WheelGuard({ children, ...rest }: ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  return <div ref={ref} {...rest}>{children}</div>;
}
