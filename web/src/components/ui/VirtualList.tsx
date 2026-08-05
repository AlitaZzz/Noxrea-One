/**
 * 轻量虚拟滚动列表。
 * 固定行高、无第三方依赖，按可视区计算渲染范围并预留 overscan 缓冲行。
 */
"use client";

import type { CSSProperties, Key, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

const OVERSCAN = 6;

/** 轻量虚拟列表（固定行高，无第三方依赖）：仅渲染可视区行 */
export function VirtualList<T>({
  items,
  itemHeight,
  rowKey,
  renderItem,
  className,
  style,
}: {
  items: T[];
  itemHeight: number;
  rowKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setViewport(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = items.length * itemHeight;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewport / itemHeight) + OVERSCAN * 2;
  const end = Math.min(items.length, start + visibleCount);
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={className}
      style={{ overflowY: "auto", position: "relative", ...style }}
    >
      <div style={{ height: total, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${start * itemHeight}px)`,
          }}
        >
          {slice.map((item, i) => (
            <div key={rowKey(item, start + i)} style={{ height: itemHeight }}>
              {renderItem(item, start + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
