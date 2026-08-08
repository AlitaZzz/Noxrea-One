/**
 * 画布快捷键 hook。
 * 处理复制 / 粘贴 / 再制、删除、全选、撤销重做与编组等键盘操作，
 * 并在存在生成中节点时禁用撤销重做。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";

import { duplicateNode } from "@/features/canvas/node-defaults";
import { EventNames, isGenerating,PASTE_OFFSET } from "@/lib/constants";
import type { MediaGenFields } from "@/features/canvas/types";
import { markDirtyImmediate, markDirtyUndo, takeCanvasSnapshot,useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";

/** 是否存在生成/处理中的节点（用于禁止撤销/重做，避免波及生成中节点） */
function hasGeneratingNode(): boolean {
  return useCanvasStore
    .getState()
    .nodes.some((n) => isGenerating((n.data as MediaGenFields).taskBinding));
}

function getSelectedNodeIds(): string[] {
  return useCanvasStore
    .getState()
    .nodes.filter((n) => n.selected)
    .map((n) => n.id);
}

function getSelectedEdgeIds(): string[] {
  return useCanvasStore
    .getState()
    .edges.filter((e) => e.selected)
    .map((e) => e.id);
}

/**
 * Global keyboard shortcuts for the canvas.
 */
export function useCanvasKeyboard() {
  const { zoomIn, zoomOut, fitView, setNodes } = useReactFlow();

  const addNodes = useCanvasStore((s) => s.addNodes);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const removeEdges = useCanvasStore((s) => s.removeEdges);
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
      if (mod && e.key === "a") {
        e.preventDefault();
        const all = useCanvasStore.getState();
        all.setNodes(all.nodes.map((n) => ({ ...n, selected: true })));
      }

      // ---- Copy ----
      if (mod && e.key === "c") {
        const selIds = getSelectedNodeIds();
        // 如果用户在画布外（如通知、弹窗文本）选中了文字，交给浏览器原生复制
        const textSelection = window.getSelection()?.toString() ?? "";
        if (selIds.length > 0 && !textSelection) {
          e.preventDefault();
          const allNodes = useCanvasStore.getState().nodes;
          const selNodes = allNodes.filter((n) => selIds.includes(n.id));
          useSelectionStore.getState().copySelected(selNodes);
        }
      }

      // ---- Paste ----
      if (mod && e.key === "v") {
        const clip = useSelectionStore.getState().clipboard;
        if (clip && clip.nodes.length > 0) {
          e.preventDefault();
          const newNodes = clip.nodes.map((n) =>
            duplicateNode(n, PASTE_OFFSET)
          );
          addNodes(newNodes);
          // Select pasted nodes
          const s = useCanvasStore.getState();
          s.setNodes(
            s.nodes.map((n) => ({
              ...n,
              selected: newNodes.some((nn) => nn.id === n.id),
            }))
          );
        }
      }

      // ---- Delete selected nodes AND edges ----
      if (e.key === "Delete" || e.key === "Backspace") {
        const selNodeIds = getSelectedNodeIds();
        const selEdgeIds = getSelectedEdgeIds();
        const hasNodeSelection = selNodeIds.length > 0;
        const hasEdgeSelection = selEdgeIds.length > 0;

        if (hasNodeSelection || hasEdgeSelection) {
          e.preventDefault();
          if (hasNodeSelection) removeNodes(selNodeIds);
          if (hasEdgeSelection) removeEdges(selEdgeIds);
        }
      }

      // ---- Escape: clear selection ----
      if (e.key === "Escape") {
        const s = useCanvasStore.getState();
        setNodes(s.nodes.map((n) => ({ ...n, selected: false })));
        useCanvasStore.getState().setEdges(
          s.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true }
        );
      }

      // ---- Group (Ctrl+G) / Ungroup (Ctrl+Shift+G) ----
      if (mod && e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EventNames.CANVAS_GROUP_NODES));
      }
      if (mod && e.key === "g" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EventNames.CANVAS_UNGROUP_NODES));
      }

      // ---- Undo ----
      if (mod && e.key === "z" && !e.shiftKey) {
        // 生成期间禁止撤销：undo 全局快照会波及生成中节点的 taskBinding，
        // 导致 SSE 结果落在过期节点上或白等后 scanAndConnect 复活僵尸任务
        if (hasGeneratingNode()) return;
        e.preventDefault();
        // 先捕获现场快照（进 redoStack，供 redo 回到撤销前），再弹出恢复目标
        const prev = undoHistory(takeCanvasSnapshot());
        if (prev) {
          const s = useCanvasStore.getState();
          s.setNodes(prev.nodes.map((n) => ({ ...n, selected: false })));
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
      if (mod && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        if (hasGeneratingNode()) return;
        e.preventDefault();
        // 先捕获现场快照（存回 undoStack，保证 redo 后还能再 undo），再弹出恢复目标
        const next = redoHistory(takeCanvasSnapshot());
        if (next) {
          const s = useCanvasStore.getState();
          s.setNodes(next.nodes.map((n) => ({ ...n, selected: false })));
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
      if (mod && e.key === "m") {
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
  }, [zoomIn, zoomOut, fitView, setNodes, resetViewport, undoHistory, redoHistory, addNodes, removeNodes, removeEdges]);
}
