/**
 * 编组节点（group-node）渲染组件。
 * 作为其他节点的父容器提供可视边框与可编辑组名，支持四角缩放，
 * 不承载媒体内容，成员管理由画布层的编组逻辑负责。
 */
"use client";

import { GroupOutlined } from "@ant-design/icons";
import type { NodeProps } from "@xyflow/react";
import { Input } from "antd";
import { memo, useCallback,useState } from "react";

import { EventNames, GROUP_NODE_MIN_HEIGHT,GROUP_NODE_MIN_WIDTH,NODE_TITLE_HEIGHT } from "@/lib/constants";
import type { GroupNode as GroupNodeType } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";

import ResizeHandle from "./ResizeHandle";

function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data.label || t("group.node"));

  const handleLabelChange = useCallback(
    (value: string) => {
      setLabel(value);
      window.dispatchEvent(
        new CustomEvent(EventNames.NODE_UPDATE_DATA, {
          detail: { nodeId: id, data: { ...data, label: value || t("group.node") } },
        })
      );
    },
    [id, data]
  );

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title — same as ImageNode */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        <span className="truncate">
          <GroupOutlined className="mr-1" />
          {editing ? (
            <Input
              size="small"
              variant="borderless"
              className="text-[13px] font-medium text-white/80"
              value={label}
              onChange={(e) => handleLabelChange(e.target.value)}
              onBlur={() => setEditing(false)}
              onPressEnter={() => setEditing(false)}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          ) : (
            <span
              className="cursor-text"
              onDoubleClick={() => setEditing(true)}
            >
              {label}
            </span>
          )}
        </span>
      </div>

      {/* Body — subtle transparent background to show group boundary */}
      <div
        className="flex-1 rounded-lg pointer-events-none"
        style={{
          background: "rgba(255, 255, 255, 0.1)",
          outline: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      />

      {/* Resize — same as ImageNode */}
      {selected && (
        <ResizeHandle
          nodeId={id}
          corner="bottom-right"
          minWidth={GROUP_NODE_MIN_WIDTH}
          minHeight={GROUP_NODE_MIN_HEIGHT}
        />
      )}

    </div>
  );
}

export default memo(GroupNode);
