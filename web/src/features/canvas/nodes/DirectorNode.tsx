/**
 * Director 节点（director-node）在画布上的入口卡片。
 * 仅做占位展示与标题编辑，点击后经页面端口打开全屏 Director 编辑器，
 * 本身不含三维逻辑，也不持有编辑器状态。
 */
"use client";

import { type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";

import { PartitionOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import ConnectionSideRail from "@/features/canvas/controls/ConnectionSideRail";
import { useCanvasPorts } from "@/features/canvas/root/CanvasPortsContext";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { DirectorNode as DirectorNodeType } from "@/features/canvas/types";

import AgentGhostOverlay from "./AgentGhostOverlay";
import NodeTitle from "./NodeTitle";

function DirectorNode({ id, data }: NodeProps<DirectorNodeType>) {
  const { t } = useTranslation();
  const { onOpenDirector } = useCanvasPorts();
  // Agent 提议-确认的幻影蒙层（删除/整理预览）
  const agentGhost = useCanvasStore((s) => s.agentPreviewNodeIds.includes(id));
  return (
    <div className="group relative w-full h-full flex flex-col node-tilt">
      {/* Title */}
      <NodeTitle
        nodeId={id}
        icon={<PartitionOutlined className="shrink-0" />}
        title={data.label}
        display={data.label || t("node.director")}
      />

      {/* Body */}
      <div className="node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body node-surface">
        {agentGhost && <AgentGhostOverlay />}
        <div className="flex flex-col items-center justify-center gap-3 p-4 text-muted-foreground">
          <PartitionOutlined className="text-5xl" />
          <span className="text-base text-center">{t("node.directorDesc")}</span>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="nodrag px-6"
            onClick={() => onOpenDirector(id)}
          >
            {t("node.directorOpen")}
          </Button>
        </div>
      </div>

      <ConnectionSideRail side="right" type="source" />
    </div>
  );
}

export default DirectorNode;
