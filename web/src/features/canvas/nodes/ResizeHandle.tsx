/**
 * 节点四角缩放手柄。
 * 处理指针拖拽过程中的尺寸计算（含最小尺寸约束与可选宽高比锁定），
 * 实时写回画布 store，被各类节点组件复用。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback, useRef } from "react";

import { ResizeCornerIcon } from "@/components/ui/icons/canvas/ResizeCornerIcon";
import { takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { EventNames } from "@/lib/constants";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface ResizeHandleProps {
  nodeId: string;
  corner: Corner;
  minWidth: number;
  minHeight: number;
  lockAspectRatio?: boolean;
  aspectRatio?: number;
}

const CORNER_CURSORS: Record<Corner, string> = {
  "top-left": "nwse-resize",
  "top-right": "nesw-resize",
  "bottom-left": "nesw-resize",
  "bottom-right": "nwse-resize",
};

export default function ResizeHandle({
  nodeId,
  corner,
  minWidth,
  minHeight,
  lockAspectRatio = false,
  aspectRatio = 1,
}: ResizeHandleProps) {
  const { getZoom } = useReactFlow();
  /** zoom 在按下时锁定：拖动途中缩放属极端操作，逐帧读取反而会让尺寸跳动 */
  const startRef = useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0, zoom: 1 });
  /** 拖拽前的快照：整个缩放只在结束时压一条历史，撤销一次即可整体回退 */
  const snapshotRef = useRef<ReturnType<typeof takeCanvasSnapshot> | null>(null);
  /** 尺寸是否真的变过：单纯点一下手柄不该留下历史记录 */
  const changedRef = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const el = document.querySelector(
        `[data-id="${nodeId}"]`
      ) as HTMLElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();

      // Read current node state from store
      const store = useCanvasStore.getState();
      const currentNode = store.nodes.find((n) => n.id === nodeId);
      if (!currentNode) return;

      // 画布缩放：尺寸是画布单位，而指针位移与 getBoundingClientRect 都是屏幕
      // 像素，三者必须统一到同一量纲，否则缩放后框与鼠标不同步
      const zoom = getZoom() || 1;
      const curW = Number(currentNode.style?.width) || rect.width / zoom;
      const curH = Number(currentNode.style?.height) || rect.height / zoom;

      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        w: curW,
        h: curH,
        px: currentNode.position.x,
        py: currentNode.position.y,
        zoom,
      };
      snapshotRef.current = takeCanvasSnapshot();
      changedRef.current = false;

      function onPointerMove(ev: PointerEvent) {
        // 指针位移是屏幕像素，尺寸是画布单位：不除以 zoom 时，画布缩放后
        // 框的位移量只有鼠标的 zoom 倍，看上去就是「框不跟手」
        const { zoom } = startRef.current;
        const dx = (ev.clientX - startRef.current.x) / zoom;
        const dy = (ev.clientY - startRef.current.y) / zoom;

        let newW = startRef.current.w;
        let newH = startRef.current.h;

        if (corner.includes("right")) newW = startRef.current.w + dx;
        if (corner.includes("left")) newW = startRef.current.w - dx;
        if (corner.includes("bottom")) newH = startRef.current.h + dy;
        if (corner.includes("top")) newH = startRef.current.h - dy;

        if (lockAspectRatio) {
          // Use the dimension that changed more as the "master"
          const wChange = Math.abs(dx) / startRef.current.w;
          const hChange = Math.abs(dy) / startRef.current.h;
          if (hChange > wChange) {
            newH = Math.max(minHeight, Math.round(newH));
            newW = Math.round(newH * aspectRatio);
          } else {
            newW = Math.max(minWidth, Math.round(newW));
            newH = Math.round(newW / aspectRatio);
          }
        } else {
          newW = Math.max(minWidth, Math.round(newW));
          newH = Math.max(minHeight, Math.round(newH));
        }

        let newX = startRef.current.px;
        let newY = startRef.current.py;
        if (corner.includes("left")) newX = startRef.current.px + (startRef.current.w - newW);
        if (corner.includes("top")) newY = startRef.current.py + (startRef.current.h - newH);

        // 只在尺寸真的变化时记一笔：被最小尺寸卡住时不应留下空历史
        if (newW !== startRef.current.w || newH !== startRef.current.h) {
          changedRef.current = true;
        }

        window.dispatchEvent(
          new CustomEvent(EventNames.NODE_UPDATE_DATA, {
            detail: {
              nodeId,
              data: {},
              style: { width: newW, height: newH },
              position: { x: newX, y: newY },
              // 逐帧写回不进历史：结束时统一压一条「缩放前」的快照
              skipHistory: true,
            },
          })
        );
      }

      function onPointerUp() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        if (changedRef.current && snapshotRef.current) {
          useHistoryStore.getState().push(snapshotRef.current);
        }
        snapshotRef.current = null;
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [nodeId, corner, minWidth, minHeight, lockAspectRatio, aspectRatio, getZoom]
  );

  const isLeft = corner.includes("left");
  const isTop = corner.includes("top");

  return (
    <div
      className="nodrag nopan absolute z-20 flex items-center justify-center"
      style={{
        cursor: CORNER_CURSORS[corner],
        [isLeft ? "left" : "right"]: 2,
        [isTop ? "top" : "bottom"]: 2,
        width: 16,
        height: 16,
      }}
      onPointerDown={onPointerDown}
    >
      <ResizeCornerIcon />
    </div>
  );
}
