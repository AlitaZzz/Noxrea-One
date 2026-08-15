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
import { useShallow } from "zustand/react/shallow";

import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { GroupNode as GroupNodeType } from "@/features/canvas/types";
import { getGroupColor,GROUP_NODE_MIN_HEIGHT,GROUP_NODE_MIN_WIDTH,GROUP_NODE_PADDING,NODE_TITLE_HEIGHT,NODE_TYPE } from "@/lib/constants";

import ResizeHandle from "./ResizeHandle";

function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  const { t } = useTranslation();
  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("node.group"));

  // Dynamic min size + member count.
  // 只派生 GroupNode 真正依赖的原始值（自身位置、成员外接矩形、成员数），
  // 用 useShallow 保证仅在"成员几何/归属"变化时重渲染，而非每次 nodes 数组变更
  // （如选中状态、无关节点位移）都重渲染整个组。
  const { gx, gy, childMaxX, childMaxY, memberCount } = useCanvasStore(
    useShallow((s) => {
      const nodes = s.nodes;
      let gx = 0, gy = 0;
      let maxX = 0, maxY = 0;
      let count = 0;
      for (const n of nodes) {
        if (n.id === id) {
          gx = n.position.x;
          gy = n.position.y;
          continue;
        }
        if (n.type !== NODE_TYPE.GROUP && n.data?.groupId === id) {
          const w = Number(n.style?.width) || 0;
          const h = Number(n.style?.height) || 0;
          const x = n.position.x - gx + w;
          const y = n.position.y - gy + h;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          count++;
        }
      }
      return { gx, gy, childMaxX: maxX, childMaxY: maxY, memberCount: count };
    })
  );
  const dynMinWidth = Math.max(GROUP_NODE_MIN_WIDTH, childMaxX + GROUP_NODE_PADDING);
  const dynMinHeight = Math.max(GROUP_NODE_MIN_HEIGHT, childMaxY + GROUP_NODE_PADDING);

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
