/**
 * 编组节点（group-node）渲染组件。
 * 作为其他节点的父容器提供可视边框与可编辑组名，支持四角缩放，
 * 不承载媒体内容，成员管理由画布层的编组逻辑负责。
 */
"use client";

import { GroupOutlined } from "@ant-design/icons";
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { GroupNode as GroupNodeType } from "@/features/canvas/types";
import { getGroupColor,GROUP_NODE_MIN_HEIGHT,GROUP_NODE_MIN_WIDTH,GROUP_NODE_PADDING,NODE_TYPE } from "@/lib/constants";

import NodeTitle from "./NodeTitle";
import ResizeHandle from "./ResizeHandle";

function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  const { t } = useTranslation();
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
      {/* Title */}
      {/* 编辑的始终是「纯名字」：计数是派生信息，不能进输入框，
          否则保存后计数被固化进 label，之后成员增减会出现重复计数。
          计数必须独立于 label 之外追加：写成 label || 带计数的默认名，
          用户一改名就永远走 label 分支，成员增减后计数不再更新 */}
      <NodeTitle
        nodeId={id}
        icon={<GroupOutlined className="shrink-0" style={{ color: "#ffffff" }} />}
        title={data.label || t("node.group")}
        display={
          data.label
            ? t("node.groupNamedWithCount", { label: data.label, count: memberCount })
            : t("node.groupWithCount", { count: memberCount })
        }
      />

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
