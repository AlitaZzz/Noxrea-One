/**
 * 画布浮层编排入口：把节点级浮层（生成面板、动态编辑面板、节点工具条、
 * 节点检查器）与画布级浮层（选区聚合工具条、批量连线、待创建连线预览、
 * 右键菜单、创建节点菜单、文件拖拽遮罩）挂到画布容器。
 *
 * 本组件只做编排，不实现面板业务规则；持有状态的 hook 仍由 CanvasSurface
 * 提供（其下 hook 负责读数与宿主校验），这里只负责分发。
 */
"use client";

import type { GlobalOverlaysProps } from "./overlays/GlobalOverlays";
import { GlobalOverlays } from "./overlays/GlobalOverlays";
import type { NodeOverlaysProps } from "./overlays/NodeOverlays";
import { NodeOverlays } from "./overlays/NodeOverlays";

type CanvasOverlaysProps = NodeOverlaysProps &
  Omit<GlobalOverlaysProps, "editingNodeId" | "editingTextNodeId">;

export default function CanvasOverlays({
  panels,
  nodes,
  selectedNodeIds,
  toolbarMode,
  ...globalOverlays
}: CanvasOverlaysProps) {
  return (
    <>
      <NodeOverlays
        panels={panels}
        nodes={nodes}
        selectedNodeIds={selectedNodeIds}
        toolbarMode={toolbarMode}
      />
      <GlobalOverlays
        editingNodeId={panels.editingNodeId}
        editingTextNodeId={panels.editingTextNodeId}
        toolbarMode={toolbarMode}
        {...globalOverlays}
      />
    </>
  );
}
