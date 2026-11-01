"use client";

/**
 * 画布流光层（specs/canvas-flow-layer.md 规则 4）。
 *
 * 在 React Flow 视口里插入一个自管 DOM 容器（节点层之前 → 连线之上、节点之下），
 * 容器内挂 canvas 与渲染循环。容器和 canvas 都由本组件直接创建、不交给 React 渲染：
 * React Flow 不管理该子树，视口子元素顺序固定（edges → connectionline → edgelabel
 * → nodes → portal），插入点不会与 React 协调冲突。
 */
import { useStore, useStoreApi } from "@xyflow/react";
import { useEffect } from "react";

import { createFlowRenderer } from "./flow-renderer";

export default function CanvasFlowLayer() {
  const store = useStoreApi();
  const domNode = useStore((state) => state.domNode);

  useEffect(() => {
    if (!domNode) return;
    const viewport = domNode.querySelector<HTMLElement>(".react-flow__viewport");
    const nodes = viewport?.querySelector<HTMLElement>(".react-flow__nodes");
    if (!viewport || !nodes) return;

    const layer = document.createElement("div");
    layer.className = "canvas-flow-layer";
    const canvas = document.createElement("canvas");
    canvas.className = "canvas-flow-layer__canvas";
    canvas.setAttribute("aria-hidden", "true");
    layer.appendChild(canvas);
    viewport.insertBefore(layer, nodes);

    const renderer = createFlowRenderer(canvas, () => {
      const { transform, width, height } = store.getState();
      return { tx: transform[0], ty: transform[1], zoom: transform[2], width, height };
    });

    return () => {
      renderer.destroy();
      layer.remove();
    };
  }, [domNode, store]);

  return null;
}
