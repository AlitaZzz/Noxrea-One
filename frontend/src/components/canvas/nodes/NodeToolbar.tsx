"use client";

import { memo, useCallback } from "react";
import { Button, Tooltip, Popover } from "antd";
import {
  CopyOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  GroupOutlined,
  UngroupOutlined,
  DownloadOutlined,
  StarOutlined,
  ScissorOutlined,
  UploadOutlined,
  SwapOutlined,
  CameraOutlined,
} from "@ant-design/icons";
import { useI18nStore } from "@/stores/i18n-store";

const NODE_ACTIONS = {
  IMAGE: "image-node" as const,
  VIDEO: "video-node" as const,
};

interface NodeToolbarProps {
  nodeId: string;
  nodeType?: string;
  onShowInspector: (nodeId: string) => void;
}

function dispatchNodeAction(nodeId: string, action: string, extra?: Record<string, unknown>) {
  window.dispatchEvent(
    new CustomEvent("canvas:node-action", { detail: { nodeId, action, ...extra } })
  );
}

function NodeToolbar({ nodeId, nodeType, onShowInspector }: NodeToolbarProps) {
  const t = useI18nStore((s) => s.t);
  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent("canvas:copy-node", { detail: { nodeId } })
      );
    },
    [nodeId]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent("canvas:delete-nodes", { detail: { nodeIds: [nodeId] } })
      );
    },
    [nodeId]
  );

  const handleInfo = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onShowInspector(nodeId);
    },
    [nodeId, onShowInspector]
  );

  return (
    <div
      className="absolute -top-[62px] left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-white dark:bg-zinc-800 rounded-md shadow-lg border border-zinc-200 dark:border-zinc-700 h-[50px] px-2 py-2 z-20"
      style={{ whiteSpace: "nowrap" }}
    >
      <Tooltip title={`${t("copy")} (Ctrl+C)`}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          icon={<CopyOutlined />}
          onClick={handleCopy}
        />
      </Tooltip>
      <Tooltip title={`${t("info")} & JSON`}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          icon={<InfoCircleOutlined />}
          onClick={handleInfo}
        />
      </Tooltip>
      <Tooltip title={`${t("group")} (Ctrl+G)`}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          icon={<GroupOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent("canvas:group-nodes"));
          }}
        />
      </Tooltip>
      {nodeType === "group-node" && (
        <Tooltip title={`${t("ungroup")} (Ctrl+Shift+G)`}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8 }}
            icon={<UngroupOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent("canvas:ungroup-nodes"));
            }}
          />
        </Tooltip>
      )}
      <Tooltip title={`${t("delete")} (Delete)`}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          className="text-white/40 hover:text-white"
          icon={<DeleteOutlined />}
          onClick={handleDelete}
        />
      </Tooltip>

      {/* Image node actions */}
      {nodeType === NODE_ACTIONS.IMAGE && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Tooltip title={t("save.assets")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<StarOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "save-asset")} />
          </Tooltip>
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col gap-1 p-1" style={{ background: "var(--canvas-bg)" }}>
              <Button type="text" size="small" onClick={() => dispatchNodeAction(nodeId, "transform", { op: "rot90" })}>{t("rotate90")}</Button>
              <Button type="text" size="small" onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipH" })}>{t("flipH")}</Button>
              <Button type="text" size="small" onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipV" })}>{t("flipV")}</Button>
            </div>}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<SwapOutlined />} />
          </Popover>
          <Tooltip title={t("crop")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ScissorOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "crop")} />
          </Tooltip>
          <Tooltip title={t("replace")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<UploadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "replace")} />
          </Tooltip>
          <Tooltip title={t("clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DeleteOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Video node actions */}
      {nodeType === NODE_ACTIONS.VIDEO && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col gap-0.5 py-1" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 160 }}>
              <Button type="text" size="small" style={{ textAlign: "left", justifyContent: "flex-start", width: "100%" }}
                onClick={() => dispatchNodeAction(nodeId, "capture-frame", { time: null })}>
                <CameraOutlined className="mr-1.5" style={{ fontSize: 14 }} /> Capture current frame
              </Button>
              <Button type="text" size="small" style={{ textAlign: "left", justifyContent: "flex-start", width: "100%" }}
                onClick={() => dispatchNodeAction(nodeId, "capture-frame", { time: 0 })}>
                <CameraOutlined className="mr-1.5" style={{ fontSize: 14 }} /> Capture first frame
              </Button>
              <Button type="text" size="small" style={{ textAlign: "left", justifyContent: "flex-start", width: "100%" }}
                onClick={() => dispatchNodeAction(nodeId, "capture-frame", { time: -1 })}>
                <CameraOutlined className="mr-1.5" style={{ fontSize: 14 }} /> Capture last frame
              </Button>
            </div>}>
            <Tooltip title={t("crop")}>
              <Button type="text" size="middle" style={{ padding: 8 }} icon={<CameraOutlined />} />
            </Tooltip>
          </Popover>
          <Tooltip title={t("replace")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<UploadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "replace")} />
          </Tooltip>
          <Tooltip title={t("clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DeleteOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);
