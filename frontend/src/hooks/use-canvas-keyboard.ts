"use client";

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore, takeCanvasSnapshot } from "@/stores/canvas-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useHistoryStore } from "@/stores/history-store";
import { duplicateNode } from "@/lib/node-defaults";
import { PASTE_OFFSET } from "@/lib/constants";

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

  const pushHistory = useHistoryStore((s) => s.push);
  const undoHistory = useHistoryStore((s) => s.undo);
  const redoHistory = useHistoryStore((s) => s.redo);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
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
        if (selIds.length > 0) {
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
          pushHistory(takeCanvasSnapshot());
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
          pushHistory(takeCanvasSnapshot());
          if (hasNodeSelection) removeNodes(selNodeIds);
          if (hasEdgeSelection) removeEdges(selEdgeIds);
        }
      }

      // ---- Escape: clear selection ----
      if (e.key === "Escape") {
        const s = useCanvasStore.getState();
        setNodes(s.nodes.map((n) => ({ ...n, selected: false })));
        useCanvasStore.getState().setEdges(
          s.edges.map((e) => ({ ...e, selected: false }))
        );
      }

      // ---- Group (Ctrl+G) / Ungroup (Ctrl+Shift+G) ----
      if (mod && e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("canvas:group-nodes"));
      }
      if (mod && e.key === "g" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("canvas:ungroup-nodes"));
      }

      // ---- Undo ----
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        const prev = undoHistory();
        if (prev) {
          const s = useCanvasStore.getState();
          s.setNodes(prev.nodes.map((n: any) => ({ ...n, selected: false })));
          s.setEdges(prev.edges.map((e: any) => ({ ...e, selected: false })));
          s.setViewport(prev.viewport);
          s.setBackground(prev.background);
          s.setTheme(prev.theme);
          if (prev.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: prev.minimapVisible });
          if (prev.snapToGrid !== undefined) useCanvasStore.setState({ snapToGrid: prev.snapToGrid });
        }
      }

      // ---- Redo ----
      if (mod && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        const next = redoHistory();
        if (next) {
          const s = useCanvasStore.getState();
          s.setNodes(next.nodes.map((n: any) => ({ ...n, selected: false })));
          s.setEdges(next.edges.map((e: any) => ({ ...e, selected: false })));
          s.setViewport(next.viewport);
          s.setBackground(next.background);
          s.setTheme(next.theme);
          if (next.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: next.minimapVisible });
          if (next.snapToGrid !== undefined) useCanvasStore.setState({ snapToGrid: next.snapToGrid });
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
  }, [zoomIn, zoomOut, fitView, setNodes, resetViewport, pushHistory, undoHistory, redoHistory, addNodes, removeNodes, removeEdges]);
}
