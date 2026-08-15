/**
 * 画布自定义事件总线监听 hook。
 * 把节点组件派发的 window 级事件（更新数据、复制、删除节点 / 连线、右键菜单）
 * 统一转成对画布 store 的操作。
 */
"use client";

import { useEffect } from "react";

import { markDirty, markDirtyImmediate,useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import { EventNames } from "@/lib/constants";

/**
 * 画布自定义事件监听 hook。
 *
 * 注册 5 个 window-level 事件监听器，处理节点数据更新、复制、删除、
 * 边删除、右键菜单等操作。
 */
export function useCanvasEvents() {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const copySelected = useSelectionStore((s) => s.copySelected);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const removeEdges = useCanvasStore((s) => s.removeEdges);
  const showCtx = useContextMenuStore((s) => s.show);

  // 1) node:update-data
  useEffect(() => {
    function onUpdateData(e: Event) {
      const { nodeId, data, style, position, immediate } = (e as CustomEvent).detail;
      if (position) {
        useCanvasStore.getState().setNodes(
          useCanvasStore.getState().nodes.map((n) =>
            n.id === nodeId ? { ...n, position } : n
          )
        );
        markDirty();
      }
      updateNodeData(nodeId, data ?? {}, style);
      if (immediate) markDirtyImmediate();
    }
    window.addEventListener(EventNames.NODE_UPDATE_DATA, onUpdateData);
    return () => window.removeEventListener(EventNames.NODE_UPDATE_DATA, onUpdateData);
  }, [updateNodeData]);

  // 2) canvas:copy-node
  useEffect(() => {
    function onCopyNode(e: Event) {
      const { nodeId } = (e as CustomEvent).detail;
      const allNodes = useCanvasStore.getState().nodes;
      const target = allNodes.find((n) => n.id === nodeId);
      if (target) copySelected([target]);
    }
    window.addEventListener(EventNames.CANVAS_COPY_NODE, onCopyNode);
    return () => window.removeEventListener(EventNames.CANVAS_COPY_NODE, onCopyNode);
  }, [copySelected]);

  // 3) canvas:delete-nodes
  useEffect(() => {
    function onDeleteNodes(e: Event) {
      const { nodeIds } = (e as CustomEvent).detail;
      removeNodes(nodeIds);
    }
    window.addEventListener(EventNames.CANVAS_DELETE_NODES, onDeleteNodes);
    return () => window.removeEventListener(EventNames.CANVAS_DELETE_NODES, onDeleteNodes);
  }, [removeNodes]);

  // 4) canvas:delete-edges
  useEffect(() => {
    function onDeleteEdges(e: Event) {
      const { edgeIds } = (e as CustomEvent).detail;
      removeEdges(edgeIds);
    }
    window.addEventListener(EventNames.CANVAS_DELETE_EDGES, onDeleteEdges);
    return () => window.removeEventListener(EventNames.CANVAS_DELETE_EDGES, onDeleteEdges);
  }, [removeEdges]);

  // 5) Right-click context menu (DOM events, not CustomEvent)
  useEffect(() => {
    function onCanvasDblClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest(".react-flow__pane") && !target.closest(".react-flow__node")) {
        showCtx(e.clientX, e.clientY);
      }
    }
    function preventCtx(e: Event) { e.preventDefault(); }
    document.addEventListener("dblclick", onCanvasDblClick, true);
    document.addEventListener("contextmenu", preventCtx, { capture: true });
    return () => {
      document.removeEventListener("dblclick", onCanvasDblClick, true);
      document.removeEventListener("contextmenu", preventCtx, { capture: true });
    };
  }, [showCtx]);
}
