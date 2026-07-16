"use client";

import { useRef, useEffect, type ReactNode } from "react";

/**
 * 包裹需要阻止 wheel 事件冒泡到 React Flow 的 UI 区域。
 *
 * React Flow 使用原生 addEventListener 监听 wheel 实现画布缩放，
 * React 合成事件的 e.stopPropagation() 无法阻止原生 DOM 冒泡。
 * WheelGuard 用原生 addEventListener 在目标元素拦截 wheel 事件，
 * 阻止其到达 React Flow 的 zoom 处理器。
 */
export default function WheelGuard({ children, className, style }: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  return <div ref={ref} className={className} style={style}>{children}</div>;
}
