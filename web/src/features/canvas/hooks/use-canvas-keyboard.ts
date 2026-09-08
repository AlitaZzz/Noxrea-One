/**
 * 画布快捷键 hook。
 * 处理复制 / 粘贴 / 再制、删除、全选、撤销重做与编组等键盘操作，
 * 并在存在生成中节点时禁用撤销重做。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";

import {
  copySelection,
  deleteSelection,
  getSelectedEdgeIds,
  getSelectedNodeIds,
  pasteClipboard,
  selectAllNodes,
} from "@/features/canvas/shared/canvas-edit-actions";
import { markDirtyUndo, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { MediaGenFields } from "@/features/canvas/types";
import { EventNames, isGenerating } from "@/lib/constants";

/** 是否存在生成/处理中的节点（用于禁止撤销/重做，避免波及生成中节点） */
function hasGeneratingNode(): boolean {
  return useCanvasStore
    .getState()
    .nodes.some((n) => isGenerating((n.data as MediaGenFields).taskBinding));
}

/**
 * Global keyboard shortcuts for the canvas.
 */
export function useCanvasKeyboard() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const resetViewport = useCanvasStore((s) => s.resetViewport);

  const undoHistory = useHistoryStore((s) => s.undo);
  const redoHistory = useHistoryStore((s) => s.redo);

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

      // ---- Paste ----
      if (mod && e.key.toLowerCase() === "v") {
        // 输入框内已在本函数开头 return，此处只会是画布语境的「粘贴节点」
        if (pasteClipboard()) e.preventDefault();
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

      // ---- Undo ----
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        // 生成期间禁止撤销：undo 全局快照会波及生成中节点的 taskBinding，
        // 导致 SSE 结果落在过期节点上或白等后 scanAndConnect 复活僵尸任务
        if (hasGeneratingNode()) return;
        e.preventDefault();
        // 先捕获现场快照（进 redoStack，供 redo 回到撤销前），再弹出恢复目标。
        // 撤销/重做整体恢复快照（含 genSettings 排序偏好）：手动重连的置尾效果随快照回滚，
        // 恢复的是被撤销操作前的精确状态——参考回到原来的位置。
        const prev = undoHistory(takeCanvasSnapshot());
        if (prev) {
          const s = useCanvasStore.getState();
          const restoredNodes = prev.nodes.map((n) => ({ ...n, selected: false }));
          s.setNodes(restoredNodes);
          s.setEdges(prev.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
          s.setViewport(prev.viewport);
          s.setBackground(prev.background);
          s.setTheme(prev.theme);
          if (prev.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: prev.minimapVisible });
          if (prev.snapToGrid !== undefined) useCanvasStore.setState({ snapToGrid: prev.snapToGrid });
          markDirtyUndo();
        }
      }

      // ---- Redo ----
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        if (hasGeneratingNode()) return;
        e.preventDefault();
        // 先捕获现场快照（存回 undoStack，保证 redo 后还能再 undo），再弹出恢复目标。
        // 重做同样整体恢复快照：精确回到撤销前的现场状态。
        const next = redoHistory(takeCanvasSnapshot());
        if (next) {
          const s = useCanvasStore.getState();
          const restoredNodes = next.nodes.map((n) => ({ ...n, selected: false }));
          s.setNodes(restoredNodes);
          s.setEdges(next.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
          s.setViewport(next.viewport);
          s.setBackground(next.background);
          s.setTheme(next.theme);
          if (next.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: next.minimapVisible });
          if (next.snapToGrid !== undefined) useCanvasStore.setState({ snapToGrid: next.snapToGrid });
          markDirtyUndo();
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
  }, [zoomIn, zoomOut, fitView, resetViewport, undoHistory, redoHistory]);
}
