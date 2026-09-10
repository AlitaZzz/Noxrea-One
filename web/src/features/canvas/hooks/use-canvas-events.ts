/**
 * 画布自定义事件总线监听 hook。
 * 把节点组件派发的 window 级事件（更新数据、复制、删除节点 / 连线、双击唤起画布菜单）
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
 * 边删除、双击唤起画布菜单等操作。
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
      const { nodeId, data, style, position, immediate, skipHistory } = (e as CustomEvent).detail;
      const store = useCanvasStore.getState();
      // 空 data 不展开：否则每次写入都会换掉 data 引用，白白击穿下游 memo
      const hasData = !!data && typeof data === "object" && Object.keys(data).length > 0;
      if (position) {
        // 位置、尺寸、数据同批写入一次：分两次 set 会触发两轮全画布重渲染，
        // 缩放这类逐帧操作下掉帧会直接表现为「框不跟手」
        store.setNodes(
          store.nodes.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  position,
                  ...(style ? { style: { ...n.style, ...style } } : {}),
                  ...(hasData ? { data: { ...n.data, ...data } } : {}),
                }
              : n,
          ),
        );
      } else {
        updateNodeData(nodeId, data ?? {}, style, { skipHistory });
      }
      markDirty();
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

  // 5) 画布菜单：由「左键双击空白处」唤起，非右键（DOM 事件，非 CustomEvent）。
  //    右键（contextmenu）在画布内一律屏蔽，仅输入框 / 可编辑区域保留浏览器原生菜单，
  //    因此这里的菜单虽然常被称作「右键菜单」，实际触发手势是双击。
  useEffect(() => {
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
    document.addEventListener("dblclick", onCanvasDblClick, true);
    document.addEventListener("contextmenu", preventCtx, { capture: true });
    return () => {
      document.removeEventListener("dblclick", onCanvasDblClick, true);
      document.removeEventListener("contextmenu", preventCtx, { capture: true });
    };
  }, [showCtx]);
}
