/**
 * 画布菜单事件 hook。
 *
 * 双击空白处唤起画布菜单；contextmenu 在画布容器内屏蔽（仅输入框 / 可编辑区域保留
 * 浏览器原生菜单）。节点数据直接由节点组件写入 store；本 hook 只负责画布菜单
 * 的 DOM 事件，不承载节点状态同步。
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
        showCtx(e.clientX, e.clientY, "create");
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
