/**
 * 节点右下角缩放手柄。
 * 按下时把指针生命周期交给 ResizeSession：缩放期只写 DOM 预览，
 * 松手一次提交。手柄自身不读写 store，也不维护几何状态。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";

import { ResizeCornerIcon } from "@/components/ui/AppIcon";
import { useResizeSession } from "@/features/canvas/resize/resize-session-context";

export interface ResizeHandleProps {
  nodeId: string;
  minWidth: number;
  minHeight: number;
}

export default function ResizeHandle({ nodeId, minWidth, minHeight }: ResizeHandleProps) {
  const session = useResizeSession();
  const { getZoom } = useReactFlow();

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      // zoom 在按下时锁定：拖动途中缩放属极端操作，逐帧读取反而会让尺寸跳动
      session.begin({
        nodeId,
        pointerId: e.pointerId,
        pointer: { x: e.clientX, y: e.clientY },
        zoom: getZoom() || 1,
        minWidth,
        minHeight,
      });
    },
    [getZoom, minHeight, minWidth, nodeId, session],
  );

  return (
    <div
      className="nodrag nopan absolute z-20 flex items-center justify-center"
      style={{ cursor: "nwse-resize", right: 2, bottom: 2, width: 16, height: 16 }}
      onPointerDown={onPointerDown}
    >
      <ResizeCornerIcon />
    </div>
  );
}
