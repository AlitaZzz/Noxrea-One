"use client";

import { useStoreApi } from "@xyflow/react";
import { useLayoutEffect, useRef } from "react";

import {
  EDGE_BASE_STROKE_WIDTH,
  EDGE_BASE_STROKE_WIDTH_VAR_NAME,
} from "@/lib/constants";

/**
 * 连线本体宽度补偿。
 *
 * `.react-flow__viewport` 用 CSS transform 缩放，SVG 的 `non-scaling-stroke`
 * 只抵消 SVG 内部变换，无法抵消 HTML 祖先的缩放（Chrome 实测），因此按
 * 1/zoom 把目标屏幕宽度换算成世界坐标，写到画布根节点的 CSS 变量上；
 * 连线样式统一读取 `EDGE_BASE_STROKE_WIDTH_VAR`。
 *
 * 根节点由组件自己的隐藏标记向上查找，而不是等 store 的 `domNode`：后者在
 * ZoomPane 的 passive effect 中才写入，晚于首帧，恢复非 1 缩放的项目时首帧
 * 会按世界坐标 1px 画细一帧。直接订阅 store 写 DOM（与 React Flow 的 Viewport
 * 同一策略）：缩放时只触发样式重算，不重渲染任何连线组件。
 */
export function EdgeBaseWidthVariable() {
  const store = useStoreApi();
  const markerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = markerRef.current?.closest<HTMLElement>(".react-flow");
    if (!root) return;

    let prevZoom: number | null = null;
    const apply = () => {
      const zoom = store.getState().transform[2];
      if (zoom === prevZoom) return;
      prevZoom = zoom;
      root.style.setProperty(
        EDGE_BASE_STROKE_WIDTH_VAR_NAME,
        `${EDGE_BASE_STROKE_WIDTH / zoom}px`
      );
    };

    apply();
    const unsubscribe = store.subscribe(apply);

    return () => {
      unsubscribe();
      root.style.removeProperty(EDGE_BASE_STROKE_WIDTH_VAR_NAME);
    };
  }, [store]);

  // 隐藏标记仅用于定位画布根节点；放在 ReactFlow 子节点中，随画布一起挂载
  return <span ref={markerRef} style={{ display: "none" }} aria-hidden="true" />;
}
