/**
 * 在画布视口中心新增各类节点的 hook。
 */
"use client";

import { useCallback } from "react";

import {
  createAudioNode,
  createGroupNode,
  createImageNode,
  createTextNode,
  createVideoNode,
  directorNode,
} from "@/features/canvas/node-defaults";
import type { AnyNode } from "@/lib/types/nodes";
import { findFreePosition, useCanvasStore } from "@/stores/canvas-store";

/** 支持的节点类型 */
export type AddNodeType = "text" | "image" | "video" | "audio" | "group" | "director";

/**
 * 在画布视口中心添加节点的 hook。
 *
 * 计算视口中心 → 创建节点 → addNodes（自动记录历史）。
 *
 * 视频节点使用更大的居中偏移（200×100 而非 120×80），因为视频默认尺寸更宽。
 * 组节点使用默认分组区域尺寸（400×200）。
 */
export function useAddNode() {
  const addNodes = useCanvasStore((s) => s.addNodes);

  const addNode = useCallback(
    (type: AddNodeType) => {
      let node: AnyNode;
      switch (type) {
        case "text":
          node = createTextNode({ x: 0, y: 0 });
          break;
        case "image":
          node = createImageNode({ x: 0, y: 0 });
          break;
        case "video":
          node = createVideoNode({ x: 0, y: 0 });
          break;
        case "audio":
          node = createAudioNode({ x: 0, y: 0 });
          break;
        case "group":
          node = createGroupNode(
            { x: 0, y: 0 },
            { width: 400, height: 200 },
          );
          break;
        case "director":
          node = directorNode({ x: 0, y: 0 });
          break;
      }

      const w = (node.style?.width as number) ?? 300;
      const h = (node.style?.height as number) ?? 200;
      node.position = findFreePosition({ width: w, height: h });

      addNodes([node]);
    },
    [addNodes],
  );

  return { addNode };
}
