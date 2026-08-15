/**
 * 在画布指定锚点附近新增各类节点的 hook。
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
import { findFreePosition, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

/** 支持的节点类型 */
export type AddNodeType = "text" | "image" | "video" | "audio" | "group" | "director";

/**
 * 在画布中添加节点的 hook。
 *
 * 计算锚点位置（at 指定的世界坐标）→ 创建节点 → addNodes（自动记录历史）。
 *
 * 视频节点使用更大的居中偏移（200×100 而非 120×80），因为视频默认尺寸更宽。
 * 组节点使用默认分组区域尺寸（400×200）。
 */
export function useAddNode() {
  const addNodes = useCanvasStore((s) => s.addNodes);

  /**
   * 添加节点。
   * @param type 节点类型
   * @param at 锚定中心点（世界坐标），必填
   */
  const addNode = useCallback(
    (type: AddNodeType, at: { x: number; y: number }) => {
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
      node.position = findFreePosition({ width: w, height: h }, at);

      addNodes([node]);
    },
    [addNodes],
  );

  return { addNode };
}
