"use client";

import { useCallback, useRef } from "react";

import { EventNames } from "@/lib/event-names";
import { useCanvasStore } from "@/stores/canvas-store";
import { ResizeCornerIcon } from "@/components/common/icons/canvas/ResizeCornerIcon";

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
  const startRef = useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 });

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

      const curW = Number(currentNode.style?.width) || rect.width;
      const curH = Number(currentNode.style?.height) || rect.height;

      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        w: curW,
        h: curH,
        px: currentNode.position.x,
        py: currentNode.position.y,
      };

      function onPointerMove(ev: PointerEvent) {
        const dx = ev.clientX - startRef.current.x;
        const dy = ev.clientY - startRef.current.y;

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

        window.dispatchEvent(
          new CustomEvent(EventNames.NODE_UPDATE_DATA, {
            detail: {
              nodeId,
              data: {},
              style: { width: newW, height: newH },
              position: { x: newX, y: newY },
            },
          })
        );
      }

      function onPointerUp() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [nodeId, corner, minWidth, minHeight, lockAspectRatio, aspectRatio]
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
