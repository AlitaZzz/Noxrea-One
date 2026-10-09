/**
 * Director 节点（director-node）在画布上的入口卡片。
 * 仅做占位展示与标题编辑，点击后把节点内保存的三维场景状态载入 director store
 * 并打开全屏 Director 编辑器，本身不含三维逻辑。
 */
"use client";

import { type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { PartitionOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import ConnectionSideRail from "@/features/canvas/controls/ConnectionSideRail";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { type DirectorNode as DirectorNodeType, type DirectorStateData } from "@/features/canvas/types";
import { useDirectorStore } from "@/features/director/director-store";

import AgentGhostOverlay from "./AgentGhostOverlay";
import NodeTitle from "./NodeTitle";

function DirectorNode({ id, data, selected }: NodeProps<DirectorNodeType>) {
  const { t } = useTranslation();
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
      <div className={`node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
        ${selected ? "node-selected" : ""} node-surface`}>
        {agentGhost && <AgentGhostOverlay />}
        <div className="flex flex-col items-center justify-center gap-3 p-4 text-muted-foreground">
          <PartitionOutlined className="text-5xl" />
          <span className="text-base text-center">{t("node.directorDesc")}</span>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="nodrag px-6"
            onClick={() => {
              const cs = useCanvasStore.getState();
              const node = cs.nodes.find(n => n.id === id);
              const directorState = (node?.data as { directorState?: DirectorStateData }).directorState;
              if (directorState) {
                useDirectorStore.getState().setRestoreState(directorState);
              }
              useDirectorStore.getState().setOpeningNodeId(id);
              cs.setDirectorOverlayOpen(true);
            }}
          >
            {t("node.directorOpen")}
          </Button>
        </div>
      </div>

      <ConnectionSideRail side="right" type="source" />
    </div>
  );
}

export default memo(DirectorNode);
