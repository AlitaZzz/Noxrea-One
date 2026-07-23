"use client";

import { PartitionOutlined } from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { Input } from "antd";
import { memo } from "react";

import { useEditableTitle } from "@/hooks/use-editable-title";
import type { DirectorNode as DirectorNodeType,DirectorStateData } from "@/lib/types";
import { useCanvasStore } from "@/stores/canvas-store";
import { useDirectorStore } from "@/stores/director-store";
import { useI18nStore } from "@/stores/i18n-store";

function DirectorNode({ id, data, selected }: NodeProps<DirectorNodeType>) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("director.node"), { syncAlt: false });

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80">
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
            {data.label || t("director.node")}
          </span>
        )}

      </div>

      {/* Body */}
      <div className={`flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
        ${selected ? "outline outline-1 outline-white/30 shadow-lg" : "outline outline-1 outline-white/10"}`}
        style={{ background: "var(--canvas-bg)" }}>
        <div className="flex flex-col items-center justify-center gap-3 p-4 text-white/40">
          <PartitionOutlined className="text-5xl" />
          <span className="text-base text-center">{t("director.desc")}</span>
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
            {t("director.open")}
          </button>
        </div>
      </div>

      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#ff8a3d" }} />
    </div>
  );
}

export default memo(DirectorNode);
