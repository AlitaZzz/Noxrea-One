/**
 * 编组节点（group-node）渲染组件。
 * 作为其他节点的父容器提供可视边框与可编辑组名，支持四角缩放，
 * 不承载媒体内容，成员管理由画布层的编组逻辑负责。
 */
"use client";

import { GroupOutlined } from "@ant-design/icons";
import type { NodeProps } from "@xyflow/react";
import { Input } from "antd";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { GroupNode as GroupNodeType } from "@/features/canvas/types";
import { getGroupColor,GROUP_NODE_MIN_HEIGHT,GROUP_NODE_MIN_WIDTH,GROUP_NODE_PADDING,NODE_TITLE_HEIGHT,NODE_TYPE } from "@/lib/constants";

import ResizeHandle from "./ResizeHandle";

function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  const { t } = useTranslation();
  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("node.group"));

  // Dynamic min size: children bounding box + padding, floored by GROUP_NODE_MIN_*
  // 子节点使用绝对坐标，需减去组节点自身坐标得到组内偏移
  const allNodes = useCanvasStore((s) => s.nodes);
  const groupPos = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.position);
  const gx = groupPos?.x ?? 0;
  const gy = groupPos?.y ?? 0;
  const childMaxX = allNodes.reduce(
    (mx, n) => (n.type !== NODE_TYPE.GROUP && n.data?.groupId === id ? Math.max(mx, n.position.x - gx + (Number(n.style?.width) || 0)) : mx),
    0
  );
  const childMaxY = allNodes.reduce(
    (my, n) => (n.type !== NODE_TYPE.GROUP && n.data?.groupId === id ? Math.max(my, n.position.y - gy + (Number(n.style?.height) || 0)) : my),
    0
  );
  const dynMinWidth = Math.max(GROUP_NODE_MIN_WIDTH, childMaxX + GROUP_NODE_PADDING);
  const dynMinHeight = Math.max(GROUP_NODE_MIN_HEIGHT, childMaxY + GROUP_NODE_PADDING);

  // 实时成员计数（纯派生，不落库）：拖入/拖出组时随 groupId 自动更新
  const memberCount = allNodes.filter((n) => n.type !== NODE_TYPE.GROUP && n.data?.groupId === id).length;

  const colorPreset = getGroupColor(data.color);

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title — same as ImageNode */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        {editingTitle ? (
          <span className="flex items-center gap-0.5 flex-1 min-w-0">
            <GroupOutlined className="shrink-0" />
            <Input
              size="small"
              variant="borderless"
              className="text-[13px] font-medium text-white/80"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onPressEnter={handleTitleSave}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          </span>
        ) : (
          <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
            <GroupOutlined className="mr-1" style={{ color: "#ffffff" }} />
            {data.label || t("node.groupWithCount", { count: memberCount })}
          </span>
        )}
      </div>

      {/* Body — 填充随配色变化，边框沿用 node-body/node-selected（与 ImageNode 一致） */}
      <div
        className={`
          node-body flex-1 rounded-lg pointer-events-none
          ${selected ? "node-selected" : ""}
        `}
        style={{ background: colorPreset.fill }}
      />

      {/* Resize — same as ImageNode */}
      {selected && (
        <ResizeHandle
          nodeId={id}
          corner="bottom-right"
          minWidth={dynMinWidth}
          minHeight={dynMinHeight}
        />
      )}

    </div>
  );
}

export default memo(GroupNode);
