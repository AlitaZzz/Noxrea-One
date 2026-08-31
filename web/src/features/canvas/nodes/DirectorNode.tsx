/**
 * Director 节点（director-node）在画布上的入口卡片。
 * 仅做占位展示与标题编辑，点击后把节点内保存的三维场景状态载入 director store
 * 并打开全屏 Director 编辑器，本身不含三维逻辑。
 */
"use client";

import { PartitionOutlined } from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { Input } from "antd";
import { type CSSProperties, memo } from "react";
import { useTranslation } from "react-i18next";

import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { type DirectorNode as DirectorNodeType, type DirectorStateData } from "@/features/canvas/types";
import { useDirectorStore } from "@/features/director/director-store";
import { NODE_HANDLE_TOP, NODE_TITLE_HEIGHT, NODE_TYPE,NODE_TYPE_COLOR } from "@/lib/constants";

function DirectorNode({ id, data, selected }: NodeProps<DirectorNodeType>) {
  const { t } = useTranslation();
  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("node.director"), { syncAlt: false });

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        {editingTitle ? (
          <span className="flex items-center gap-0.5 flex-1 min-w-0">
            <PartitionOutlined className="shrink-0" />
            <Input
              size="small"
              variant="borderless"
              className="text-[13px] font-medium text-white/80"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onPressEnter={handleTitleSave}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          </span>
        ) : (
          <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
            <PartitionOutlined className="mr-1" />
            {data.label || t("node.director")}
          </span>
        )}

      </div>

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

      <Handle type="source" position={Position.Right} style={{ "--handle-color": NODE_TYPE_COLOR[NODE_TYPE.DIRECTOR], top: NODE_HANDLE_TOP, zIndex: 10 } as CSSProperties} />
    </div>
  );
}

export default memo(DirectorNode);
