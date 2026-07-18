"use client";

import { useCallback } from "react";
import { useCanvasStore, takeCanvasSnapshot, getViewportCenter } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";
import {
  createTextNode,
  createImageNode,
  createVideoNode,
  createGroupNode,
} from "@/lib/node-defaults";

/** 支持的节点类型 */
export type AddNodeType = "text" | "image" | "video" | "group";

/**
 * 在画布视口中心添加节点的 hook。
 *
 * 封装了 push 历史快照 → 计算视口中心 → 创建节点 → addNodes 的通用流程。
 *
 * 视频节点使用更大的居中偏移（200×100 而非 120×80），因为视频默认尺寸更宽。
 * 组节点使用默认分组区域尺寸（400×200）。
 */
export function useAddNode() {
  const addNodes = useCanvasStore((s) => s.addNodes);
  const pushHistory = useHistoryStore((s) => s.push);

  const addNode = useCallback(
    (type: AddNodeType) => {
      pushHistory(takeCanvasSnapshot());
      const { x: cx, y: cy } = getViewportCenter();

      let node: ReturnType<typeof createTextNode>;
      switch (type) {
        case "text":
          node = createTextNode({ x: cx - 120, y: cy - 80 });
          break;
        case "image":
          node = createImageNode({ x: cx - 120, y: cy - 80 });
          break;
        case "video":
          node = createVideoNode({ x: cx - 200, y: cy - 100 });
          break;
        case "group":
          node = createGroupNode(
            { x: cx - 200, y: cy - 100 },
            { width: 400, height: 200 },
          );
          break;
      }
      addNodes([node]);
    },
    [addNodes, pushHistory],
  );

  return { addNode };
}
