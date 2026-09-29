/**
 * 框选外框的批量连线轨道（仅输出方向）：≥2 个非组节点选中时，
 * 由 InfiniteCanvas 以 ViewportPortal 渲染在外框右缘，参与集 = 选中节点。
 * 与节点轨道同一套两段式架构：透明条带（80px 命中区）+ 镂空圆点（静止于
 * 贴框缘 RAIL_DOT_EDGE_GAP，hover 条带内二维跟随），复用 .connection-rail /
 * .connection-rail-dot 样式与 use-rail-dot-follow。
 * 唯一例外是常显（.batch-connect-handle 覆写 opacity）——外框不是节点，
 * 没有 hover/选中态可依托；条带高 = RAIL_WIDTH（正方形命中区，外框恒
 * 高于 80px 无需按外框夹窄；ViewPortal 内无定位上下文，min(100%, 80px)
 * 的百分比参照失效，高度由 CSS 变量 --rail-width 取常量 80）。
 * 拖线语义（拖到节点全有或全无扇出 / 拖到空白弹创建菜单 / 拖回参与集取消）、
 * 束线预览与目标倾斜反馈全部在 use-batch-connect-drag，
 * 与组节点的批量连接轨道（GroupConnectRail，双向）共用同一实现。
 */
"use client";

import { Position, ViewportPortal } from "@xyflow/react";
import { useCallback } from "react";

import { RAIL_WIDTH } from "@/lib/constants";

import PendingConnectionPreview from "./PendingConnectionPreview";
import { useBatchConnectDrag } from "./use-batch-connect-drag";
import { useRailDotFollow } from "./use-rail-dot-follow";

interface Props {
  /** 轨道条带左上角锚点（画布坐标：外框右缘正中，条带自此向右延伸） */
  anchor: { x: number; y: number };
  /** 参与集节点 id（框选 = 选中节点） */
  participantIds: string[];
  onConnect: (pairs: { source: string; target: string }[]) => void;
  onConnectToBlank: (
    participantIds: string[],
    canvasPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
    direction: "output" | "input"
  ) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
}

export default function BatchConnectHandle({
  anchor,
  participantIds,
  onConnect,
  onConnectToBlank,
  onDragStart,
  onDragEnd,
  screenToFlowPosition,
}: Props) {
  const getParticipantIds = useCallback(() => participantIds, [participantIds]);
  const { startDrag, preview } = useBatchConnectDrag({
    direction: "output",
    getParticipantIds,
    onConnect,
    onConnectToBlank,
    onDragStart,
    onDragEnd,
    screenToFlowPosition,
  });
  const { dotRef, restTransform, onPointerEnter, onPointerMove, onPointerLeave } =
    useRailDotFollow("right", RAIL_WIDTH);

  return (
    <ViewportPortal>
      <div
        className="nopan nodrag react-flow__handle connection-rail batch-connect-handle"
        style={{
          left: anchor.x,
          top: anchor.y,
          transform: "translate(0, -50%)",
          zIndex: 30,
        }}
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
    </ViewportPortal>
  );
}
