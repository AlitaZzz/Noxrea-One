/**
 * 框选外框的批量连线 Handle（仅输出方向）：≥2 个非组节点选中时，
 * 由 InfiniteCanvas 以 ViewportPortal 渲染在外框右缘正中，参与集 = 选中节点。
 * 常显（.batch-connect-handle 强制）——外框不是节点，没有 hover/选中态可依托，
 * 与节点轨道「hover/选中显隐」的标准规则无关。
 * 拖线语义（拖到节点全有或全无扇出 / 拖到空白弹创建菜单 / 拖回参与集取消）、
 * 束线预览与目标倾斜反馈全部在 use-batch-connect-drag，
 * 与组节点的批量输出轨道（GroupConnectRail）共用同一实现。
 * 样式复用节点 Handle 的 .react-flow__handle 类（尺寸/加号图标/hover 放大），
 * 定位由组件内联 left/top 提供，复用 .react-flow__handle-right 的外浮 transform。
 */
"use client";

import { Position, ViewportPortal } from "@xyflow/react";
import { useCallback } from "react";

import PendingConnectionPreview from "./PendingConnectionPreview";
import { useBatchConnectDrag } from "./use-batch-connect-drag";

interface Props {
  /** Handle 悬浮位置（画布坐标，复用 .react-flow__handle-right 的外浮 transform） */
  anchor: { x: number; y: number };
  /** 参与集节点 id（框选 = 选中节点） */
  participantIds: string[];
  onConnectToNode: (participantIds: string[], targetId: string) => void;
  onConnectToBlank: (
    participantIds: string[],
    canvasPosition: { x: number; y: number },
    screenPosition: { x: number; y: number }
  ) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
}

export default function BatchConnectHandle({
  anchor,
  participantIds,
  onConnectToNode,
  onConnectToBlank,
  onDragStart,
  onDragEnd,
  screenToFlowPosition,
}: Props) {
  const getParticipantIds = useCallback(() => participantIds, [participantIds]);
  const { startDrag, preview } = useBatchConnectDrag({
    getParticipantIds,
    onConnectToNode,
    onConnectToBlank,
    onDragStart,
    onDragEnd,
    screenToFlowPosition,
  });

  return (
    <ViewportPortal>
      <div
        className="nopan nodrag react-flow__handle react-flow__handle-right source batch-connect-handle"
        style={{
          left: anchor.x,
          top: anchor.y,
          cursor: "crosshair",
          zIndex: 30,
        }}
        onPointerDown={startDrag}
      />
      {preview &&
        preview.sources.map((from, i) => (
          <PendingConnectionPreview key={i} from={from} to={preview.to} fromPosition={Position.Right} />
        ))}
    </ViewportPortal>
  );
}
