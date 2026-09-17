/**
 * 画布快捷键 hook。
 * 处理复制 / 粘贴 / 再制、删除、全选、撤销重做与编组等键盘操作，
 * 并在存在生成中节点时禁用撤销重做。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef } from "react";

import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  getSelectedEdgeIds,
  getSelectedNodeIds,
  hasGeneratingNode,
  pasteFromClipboardContent,
  redoAction,
  selectAllNodes,
  undoAction,
} from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { EventNames } from "@/lib/constants";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";

/**
 * Global keyboard shortcuts for the canvas.
 */
export function useCanvasKeyboard() {
  const { zoomIn, zoomOut, fitView, screenToFlowPosition } = useReactFlow();

  const resetViewport = useCanvasStore((s) => s.resetViewport);

  // 跟踪光标位置：Ctrl+V 粘贴跟随光标（Figma / tldraw 约定）。
  // null = 尚未捕获到任何鼠标移动（如刷新后直接键盘操作），粘贴走视口中心兜底
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // ---- 智能粘贴：监听原生 paste 事件（免权限读取系统剪贴板） ----
  // 内容判定顺序：图片 → 走上传管道建图片节点；我们复制的节点 JSON（带标记）
  // → 还原节点（支持跨标签页）；普通文本 → 建文本节点；空 → 回退内部剪贴板。
  // 输入框 / Tiptap 内的原生粘贴在监听器开头放行，不受影响。
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const state = useCanvasStore.getState();
      if (state.modalOpen || state.directorOverlayOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      if (!e.clipboardData) return;

      // 粘贴落点：光标在画布上 → 光标处；不在（如悬停面板）或未捕获到光标 → 画布视口中心
      const container = document.querySelector(".canvas-container");
      const rect = container?.getBoundingClientRect();
      const center = {
        x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
      };
      const pointer = lastPointerRef.current;
      const overCanvas = !!pointer && !!container?.contains(document.elementFromPoint(pointer.x, pointer.y));
      const at = overCanvas
        ? screenToFlowPosition({ x: pointer.x, y: pointer.y })
        : screenToFlowPosition(center);

      const imageFiles = [...e.clipboardData.items]
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((f): f is File => !!f);
      const text = e.clipboardData.getData("text/plain") ?? "";
      if (pasteFromClipboardContent({ imageFiles, text }, at)) e.preventDefault();
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [screenToFlowPosition]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip canvas shortcuts when a modal or director overlay is open
      const state = useCanvasStore.getState();
      if (state.modalOpen || state.directorOverlayOpen) return;

      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const mod = e.ctrlKey || e.metaKey;

      // ---- Zoom ----
      if (mod && e.key === "=") { e.preventDefault(); zoomIn(); }
      if (mod && e.key === "-") { e.preventDefault(); zoomOut(); }
      if (mod && e.key === "0") {
        e.preventDefault();
        resetViewport();
        fitView({ duration: 300 });
      }

      // ---- Select All ----
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllNodes();
      }

      // ---- Copy ----
      if (mod && e.key.toLowerCase() === "c") {
        const selIds = getSelectedNodeIds();
        // 如果用户在画布外（如通知、弹窗文本）选中了文字，交给浏览器原生复制
        const textSelection = window.getSelection()?.toString() ?? "";
        if (selIds.length > 0 && !textSelection) {
          e.preventDefault();
          copySelection();
        }
      }

      // ---- Duplicate ----
      // Ctrl+D 浏览器默认行为是收藏书签，必须 preventDefault
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
      }

      // ---- Delete selected nodes AND edges ----
      if (e.key === "Delete" || e.key === "Backspace") {
        const selNodeIds = getSelectedNodeIds();
        const selEdgeIds = getSelectedEdgeIds();

        if (selNodeIds.length > 0 || selEdgeIds.length > 0) {
          e.preventDefault();
          deleteSelection();
        }
      }

      // ---- Escape: clear selection ----
      if (e.key === "Escape") {
        const s = useCanvasStore.getState();
        // 必须写回 zustand store：画布是受控模式（nodes 由 store 提供），
        // React Flow 的 setNodes() 只改它自己的内部 store、不触发 onNodesChange，
        // 会导致 selectedNodeIds 不更新（工具栏不消失）且下次同步时选区“复活”。
        s.setNodes(s.nodes.map((n) => ({ ...n, selected: false })));
        s.setEdges(
          s.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true }
        );
      }

      // ---- Group (Ctrl+G) / Ungroup (Ctrl+Shift+G) ----
      // 注意：按下 Shift 时 e.key 返回大写 'G'，必须用 toLowerCase() 匹配
      if (mod && e.key.toLowerCase() === "g" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EventNames.CANVAS_GROUP_NODES));
      }
      if (mod && e.key.toLowerCase() === "g" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EventNames.CANVAS_UNGROUP_NODES));
      }

      // ---- Undo / Redo ----
      // 生成中节点会全局禁用撤销/重做（避免波及 taskBinding），此前是静默拦截，
      // 用户按了没反应会以为快捷键丢了——这里补一条提示。
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        if (hasGeneratingNode()) {
          showGlobalMessage().info(i18n.t("shortcuts.undoBlocked"));
        } else {
          undoAction();
        }
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        if (hasGeneratingNode()) {
          showGlobalMessage().info(i18n.t("shortcuts.undoBlocked"));
        } else {
          redoAction();
        }
      }

      // ---- Toggle minimap ----
      if (mod && e.key.toLowerCase() === "m") {
        e.preventDefault();
        useCanvasStore.getState().toggleMinimap();
      }

      // ---- Shortcuts help ----
      if (e.key === "?") {
        useCanvasStore.getState().setShortcutsVisible(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomIn, zoomOut, fitView, resetViewport, screenToFlowPosition]);
}
