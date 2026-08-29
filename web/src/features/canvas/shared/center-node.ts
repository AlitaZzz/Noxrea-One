/**
 * 「把某个节点居中定位到画布（视口）中心」的公共工具。
 *
 * - getNodeCenter(node)：纯函数，返回节点几何中心的世界坐标。
 *   尺寸优先取实测值（node.measured），其次是 node.width/height，
 *   全部缺失时才回退到 200，避免回退猜测造成视口偏移。
 * - useCenterNode()：Hook，返回一个以给定节点为中心对齐视口的回调。
 *   须在 ReactFlowProvider 内使用。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";

import type { AnyNode } from "@/features/canvas/types";

/** 节点实测尺寸回退值（未测量到的兜底猜测） */
const FALLBACK_SIZE = 200;

/** 计算节点的几何中心（世界坐标）。尺寸缺省时回退到一个合理猜测。 */
export function getNodeCenter(node: AnyNode): { x: number; y: number } {
  const width =
    node.measured?.width ?? ((node.width as number | undefined) ?? FALLBACK_SIZE);
  const height =
    node.measured?.height ?? ((node.height as number | undefined) ?? FALLBACK_SIZE);
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
  };
}

/** 拿到「把节点平移到视口中心」的方法（须在 ReactFlowProvider 内使用） */
export function useCenterNode() {
  const { setCenter } = useReactFlow();
  return useCallback(
    (node: AnyNode) => {
      const { x, y } = getNodeCenter(node);
      setCenter(x, y, { zoom: 1.0, duration: 300 });
    },
    [setCenter],
  );
}