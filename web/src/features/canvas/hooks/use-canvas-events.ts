/**
 * 画布菜单事件 hook。
 *
 * 双击空白处唤起画布菜单；contextmenu 在画布容器内屏蔽（仅输入框 / 可编辑区域保留
 * 浏览器原生菜单）。节点数据写入此前也经本文件的 NODE_UPDATE_DATA 事件总线
 * 转译回 store（与 zustand 双写通道），已拆除——节点组件直接调用
 * store.updateNodeVisual 单写通道；canvas:copy/delete 系列事件经查无派发方，
 * 死监听一并移除。CANVAS_NODE_ACTION（节点组件命令）与 CANVAS_GROUP/UNGROUP
 * （成组命令）为跨组件命令通道，与 store 写入无关，仍走事件派发。
 */
"use client";

import { type RefObject, useEffect } from "react";

import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";

/**
 * 在画布容器内注册菜单相关 DOM 事件监听，避免全局文档事件影响其他浮层。
 */
export function useCanvasEvents(containerRef: RefObject<HTMLElement | null>) {
  const showCtx = useContextMenuStore((s) => s.show);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function onCanvasDblClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest(".react-flow__pane") && !target.closest(".react-flow__node")) {
        showCtx(e.clientX, e.clientY);
      }
    }
    // 输入框 / 可编辑区域保留原生右键菜单（粘贴、拼写检查等），其余位置屏蔽画布默认菜单
    function preventCtx(e: Event) {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
      e.preventDefault();
    }
    container.addEventListener("dblclick", onCanvasDblClick, true);
    container.addEventListener("contextmenu", preventCtx, { capture: true });
    return () => {
      container.removeEventListener("dblclick", onCanvasDblClick, true);
      container.removeEventListener("contextmenu", preventCtx, { capture: true });
    };
  }, [containerRef, showCtx]);
}
