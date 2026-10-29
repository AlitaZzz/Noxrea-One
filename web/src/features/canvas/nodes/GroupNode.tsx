/**
 * 编组节点（group-node）渲染组件。
 * 作为其他节点的父容器提供可视边框与可编辑组名，支持四角缩放，
 * 不承载媒体内容，成员管理由画布层的编组逻辑负责。
 */
"use client";

import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { GroupIcon } from "@/components/ui/AppIcon";
import GroupConnectRail from "@/features/canvas/controls/GroupConnectRail";
import { getGroupMembership } from "@/features/canvas/shared/canvas-derived";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { GroupNode as GroupNodeType } from "@/features/canvas/types";
import { getGroupColor,GROUP_NODE_MIN_HEIGHT,GROUP_NODE_MIN_WIDTH,GROUP_NODE_PADDING } from "@/lib/constants";

import AgentGhostOverlay from "./AgentGhostOverlay";
import NodeTitle from "./NodeTitle";
import ResizeHandle from "./ResizeHandle";

interface GroupMetrics {
  childMaxX: number;
  childMaxY: number;
  memberCount: number;
}

/** 无成员组的稳定引用：空组成员几何恒为 0（useShallow 按字段比较）。 */
const NO_MEMBERS: GroupMetrics = { childMaxX: 0, childMaxY: 0, memberCount: 0 };

function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  const { t } = useTranslation();
  // Agent 提议-确认的幻影蒙层（删除/整理预览）
  const agentGhost = useCanvasStore((s) => s.agentPreviewNodeIds.includes(id));
  // 拖入高亮：拖拽中的节点松手将加入本组（瞬态字段，见 canvas-store.dragOverGroupId）
  const dragOver = useCanvasStore((s) => s.dragOverGroupId === id);
  // Dynamic min size + member count.
  // 只派生 GroupNode 真正依赖的原始值（成员相对矩形、成员数），用 useShallow
  // 保证仅在"成员几何/归属"变化时重渲染，而非每次 nodes 数组变更
  // （如选中状态、无关节点位移）都重渲染整个组。
  // 成员归属来自画布共享投影（按 nodes 引用缓存）：位置变化产生新的 nodes 引用
  // （拖动提交一次、整理动画逐帧），
  // 全表归属仍会重组一次（O(N)），但所有组共享同一份结果，本组件只遍历本组成员。
  // 成员 position 是组内相对坐标，直接与组框尺寸比较即可。
  const { childMaxX, childMaxY, memberCount } = useCanvasStore(
    useShallow((s) => {
      const members = getGroupMembership(s.nodes).membersByGroup.get(id);
      if (!members || members.length === 0) return NO_MEMBERS;
      let maxX = 0, maxY = 0;
      for (const n of members) {
        const w = Number(n.style?.width) || 0;
        const h = Number(n.style?.height) || 0;
        const x = n.position.x + w;
        const y = n.position.y + h;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { childMaxX: maxX, childMaxY: maxY, memberCount: members.length };
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
        icon={<GroupIcon className="shrink-0" />}
        title={data.label}
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
          ${dragOver ? "node-drag-over" : ""}
        `}
        style={{ background: colorPreset.fill }}
      />

      {agentGhost && <AgentGhostOverlay />}

      {/* 批量连接轨道（左入右出）：样式/显隐对齐普通节点（渲染在节点 DOM 内走
          标准规则），有成员才有可接驳的对象，空组不渲染 */}
      {memberCount > 0 && (
        <>
          <GroupConnectRail groupId={id} side="left" />
          <GroupConnectRail groupId={id} side="right" />
        </>
      )}

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

export default GroupNode;
