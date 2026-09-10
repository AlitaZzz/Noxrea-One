/**
 * Director 节点（director-node）在画布上的入口卡片。
 * 仅做占位展示与标题编辑，点击后把节点内保存的三维场景状态载入 director store
 * 并打开全屏 Director 编辑器，本身不含三维逻辑。
 */
"use client";

import { PartitionOutlined } from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { type DirectorNode as DirectorNodeType, type DirectorStateData } from "@/features/canvas/types";
import { useDirectorStore } from "@/features/director/director-store";
import { NODE_HANDLE_TOP } from "@/lib/constants";

import NodeTitle from "./NodeTitle";

function DirectorNode({ id, data, selected }: NodeProps<DirectorNodeType>) {
  const { t } = useTranslation();
  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <NodeTitle
        nodeId={id}
        icon={<PartitionOutlined className="shrink-0" />}
        title={data.label || t("node.director")}
      />

      {/* Body */}
      <div className={`node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
        ${selected ? "node-selected" : ""}`}
        style={{ background: "var(--canvas-bg)" }}>
        <div className="flex flex-col items-center justify-center gap-3 p-4 text-white/40">
          <PartitionOutlined className="text-5xl" />
          <span className="text-base text-center">{t("node.directorDesc")}</span>
          <button className="node-upload-btn nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base"
            onClick={() => {
              const cs = useCanvasStore.getState();
              const node = cs.nodes.find(n => n.id === id);
              const directorState = (node?.data as { directorState?: DirectorStateData }).directorState;
              if (directorState) {
                useDirectorStore.getState().setRestoreState(directorState);
              }
              useDirectorStore.getState().setOpeningNodeId(id);
              cs.setDirectorOverlayOpen(true);
            }}>
            {t("node.directorOpen")}
          </button>
        </div>
      </div>

      <Handle type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP, zIndex: 10 }} />
    </div>
  );
}

export default memo(DirectorNode);
