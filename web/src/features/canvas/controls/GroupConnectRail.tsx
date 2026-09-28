/**
 * 组节点的批量输出连接轨道：样式与显隐完全对齐普通节点的 ConnectionSideRail。
 *
 * 根因设计：轨道必须渲染在 GroupNode 的节点 DOM 内，而不是 ViewportPortal——
 * 只有进节点 DOM，标准 Handle 显隐规则（hover 节点显示 / 选中且空闲常驻 /
 * 按住保持，见 globals.css「Handle / 轨道显示规则」）才会作用于它，与普通
 * 节点的轨道一致；此前经 ViewportPortal 渲染够不到这些规则，只能强制常显，
 * 这正是组 Handle 与其他节点「样式不一样」的原因。
 *
 * 轨道本体是普通 div（非 React Flow <Handle>）：拖线不能交给 Handle 机制，
 * 否则连线源会变成组节点（组不可连、也不该有组级边实体）；改由
 * use-batch-connect-drag 以组成员为参与集自行建边（成员→目标扇出）。
 * 因此挂 .react-flow__handle 类复用轨道样式与显隐规则，但只是视觉外壳。
 * 回调经 BatchConnectContext 注入；圆点二维跟随与普通轨道共用 use-rail-dot-follow。
 */
"use client";

import { Position } from "@xyflow/react";
import { useCallback } from "react";

import { groupMembers } from "@/features/canvas/shared/group-bounds";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useBatchConnect } from "@/providers/BatchConnectContext";

import PendingConnectionPreview from "./PendingConnectionPreview";
import { useBatchConnectDrag } from "./use-batch-connect-drag";
import { useRailDotFollow } from "./use-rail-dot-follow";

interface Props {
  /** 所属组节点 id */
  groupId: string;
}

export default function GroupConnectRail({ groupId }: Props) {
  const { onConnectToNode, onConnectToBlank, onDragStart, onDragEnd, screenToFlowPosition } =
    useBatchConnect();
  const { startDrag, preview } = useBatchConnectDrag({
    // 参与集 = 组成员（显式归属），拖起时从 store 现取
    getParticipantIds: useCallback(
      () => groupMembers(useCanvasStore.getState().nodes, groupId).map((m) => m.id),
      [groupId]
    ),
    onConnectToNode,
    onConnectToBlank,
    onDragStart,
    onDragEnd,
    screenToFlowPosition,
  });
  const { dotRef, restTransform, onPointerEnter, onPointerMove, onPointerLeave } =
    useRailDotFollow("right");

  return (
    <>
      <div
        className="nopan nodrag react-flow__handle react-flow__handle-right connection-rail connection-rail-right"
        style={{ top: "50%" }}
        onPointerDown={startDrag}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <span ref={dotRef} className="connection-rail-dot" style={{ transform: restTransform }} />
      </div>
      {preview &&
        preview.sources.map((from, i) => (
          <PendingConnectionPreview key={i} from={from} to={preview.to} fromPosition={Position.Right} />
        ))}
    </>
  );
}
