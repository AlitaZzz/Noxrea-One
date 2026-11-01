"use client";

import { useNodeSelected } from "@/features/canvas/hooks/use-node-selected";

import ResizeHandle, { type ResizeHandleProps } from "./ResizeHandle";

/**
 * 选中态才挂载的缩放手柄。
 *
 * 选中订阅放在这一层：节点主体不再因 `selected` 重渲染，手柄的挂载/卸载只
 * 影响自身子树（见 shared/memo-canvas-node.ts）。
 */
export default function SelectionResizeHandle(props: ResizeHandleProps) {
  const selected = useNodeSelected(props.nodeId);
  return selected ? <ResizeHandle {...props} /> : null;
}
