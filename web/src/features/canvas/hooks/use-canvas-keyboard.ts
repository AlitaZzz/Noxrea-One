/**
 * 画布快捷键 hook。
 * 处理复制 / 粘贴 / 再制、删除、全选、撤销重做与编组等键盘操作，
 * 并在存在生成中节点时禁用撤销重做。
 */

"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef } from "react";

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useCanvasClipboardFeedback } from "@/features/canvas/hooks/use-canvas-clipboard-feedback";
import { useCanvasInputBlocked } from "@/features/canvas/root/CanvasInputGateContext";
import { useCanvasPorts } from "@/features/canvas/root/CanvasPortsContext";
import {
  clearSelection,
  copySelection,
  deleteSelection,
  duplicateSelection,
  getSelectedEdgeIds,
  getSelectedNodeIds,
  hasGeneratingNode,
  isMediaEditorOpen,
  nudgeSelectedNodes,
  pasteClipboard,
  pasteFromClipboardContent,
  redoAction,
  selectAllNodes,
  undoAction,
} from "@/features/canvas/shared/canvas-edit-actions";
import { parsePasteEventContent, readSystemClipboard } from "@/features/canvas/shared/canvas-system-clipboard";
import { isEditableTarget } from "@/features/canvas/shared/dom";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { EventNames } from "@/lib/constants";
import i18n from "@/lib/i18n/config";

/**
 * Global keyboard shortcuts for the canvas.
 */
export function useCanvasKeyboard() {
  const { message } = useAppFeedback();
  const notifyClipboardWrite = useCanvasClipboardFeedback();
  const { zoomIn, zoomOut, fitView, screenToFlowPosition } = useReactFlow();
  const inputBlocked = useCanvasInputBlocked();
  const { onOpenShortcuts } = useCanvasPorts();

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
  // 同步可用内容优先级：带标记 HTML / Noxrea 载荷 → 图片 → 普通文本。
  // Chrome 不把自定义 MIME 暴露给 paste 事件：事件没有任何标准内容时，
  // 先 preventDefault，再在同一事件调用栈内启动 navigator.clipboard.read()
  // 读取自定义格式；失败或为空回退内部剪贴板。
  // 输入框 / Tiptap 内的原生粘贴在监听器开头放行，不受影响。
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (inputBlocked) return;
      if (isEditableTarget(e.target)) return;

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

      const content = parsePasteEventContent(e.clipboardData);
      if (content.payloadJson !== undefined) {
        // 载荷非法时同样吞掉事件：不降级为文本节点，也不触发内部剪贴板
        e.preventDefault();
        pasteFromClipboardContent(content, at);
        return;
      }
      if (content.imageFiles.length > 0 || content.text.trim()) {
        if (pasteFromClipboardContent(content, at)) e.preventDefault();
        return;
      }

      // 事件里没有任何可用的标准内容：自定义 MIME 只有异步 read() 可见
      e.preventDefault();
      void readSystemClipboard()
        .then((systemContent) => {
          if (systemContent) {
            pasteFromClipboardContent(systemContent, at);
          } else {
            pasteClipboard(at);
          }
        })
        .catch(() => {
          pasteClipboard(at);
        });
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [inputBlocked, screenToFlowPosition]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Focused controls and floating layers own the keys they have consumed.
      if (e.defaultPrevented) return;

      // Skip canvas shortcuts when a page-level overlay blocks input,
      // or when a media editor panel (标注/裁剪/选帧/片段截取) owns the keyboard
      const state = useCanvasStore.getState();
      if (inputBlocked || isMediaEditorOpen()) return;

      const mod = e.ctrlKey || e.metaKey;
      // 文本节点编辑态例外：Tiptap 内部历史被禁用（undoRedo: false），画布 store
      // 历史是唯一撤销源，Ctrl+Z / Ctrl+Y 必须路由到画布级 undo/redo 而不是让位。
      // 其余可编辑目标（普通 input/textarea）仍保持浏览器原生撤销。
      const undoRedoAttempt =
        mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y");
      if (isEditableTarget(e.target) && !(state.editingTextNodeId !== null && undoRedoAttempt)) return;

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
          copySelection(notifyClipboardWrite);
        }
      }

      // ---- Duplicate ----
      // Ctrl+D 浏览器默认行为是收藏书签，必须 preventDefault
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
      }

      // ---- Move selected nodes with arrow keys ----
      // RF 的 a11y 焦点路径（nodesFocusable/disableKeyboardA11y）已永久关闭，
      // 方向键移动由本 hook 统一持有：不依赖焦点，编辑面板打开时上方守卫
      // 直接让位（方向键归面板滑轨），关闭后即刻恢复，任何焦点状态下行为一致
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        const direction = {
          ArrowLeft: { x: -1, y: 0 },
          ArrowRight: { x: 1, y: 0 },
          ArrowUp: { x: 0, y: -1 },
          ArrowDown: { x: 0, y: 1 },
        }[e.key];
        if (nudgeSelectedNodes(direction, e.shiftKey ? 4 : 1)) e.preventDefault();
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
      // 必须写回 zustand store：画布是受控模式（nodes 由 store 提供），
      // React Flow 的 setNodes() 只改它自己的内部 store、不触发 onNodesChange，
      // 会导致 selectedNodeIds 不更新（工具栏不消失）且下次同步时选区“复活”。
      if (e.key === "Escape") clearSelection();

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
          message.info(i18n.t("shortcuts.undoBlocked"));
        } else {
          undoAction();
        }
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        if (hasGeneratingNode()) {
          message.info(i18n.t("shortcuts.undoBlocked"));
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
        onOpenShortcuts();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomIn, zoomOut, fitView, inputBlocked, message, notifyClipboardWrite, onOpenShortcuts, resetViewport, screenToFlowPosition]);
}
