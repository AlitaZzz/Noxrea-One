"use client";

import { memo, useCallback } from "react";
import { Button, Tooltip } from "antd";
import {
  CopyOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  GroupOutlined,
  UngroupOutlined,
} from "@ant-design/icons";
import { useI18nStore } from "@/stores/i18n-store";

interface NodeToolbarProps {
  nodeId: string;
  nodeType?: string;
  onShowInspector: (nodeId: string) => void;
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
      className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-white dark:bg-zinc-800 rounded-md shadow-lg border border-zinc-200 dark:border-zinc-700 px-1 py-0.5 z-20"
      style={{ whiteSpace: "nowrap" }}
    >
      <Tooltip title={`${t("copy")} (Ctrl+C)`}>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={handleCopy}
        />
      </Tooltip>
      <Tooltip title={`${t("info")} & JSON`}>
        <Button
          type="text"
          size="small"
          icon={<InfoCircleOutlined />}
          onClick={handleInfo}
        />
      </Tooltip>
      <Tooltip title={`${t("group")} (Ctrl+G)`}>
        <Button
          type="text"
          size="small"
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
            size="small"
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
          size="small"
          className="text-white/40 hover:text-white"
          icon={<DeleteOutlined />}
          onClick={handleDelete}
        />
      </Tooltip>
    </div>
  );
}

export default memo(NodeToolbar);
