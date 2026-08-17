/**
 * 拖拽连接松手落在空白画布、弹出「创建连接节点」菜单期间，
 * 持续渲染的绿色流光预览线（模拟 tigerowo 的 ActiveConnectionPath）。
 * 起点为发起端 Handle 锚点，终点为菜单弹出位置（鼠标落点），
 * 复用与拖拽预览线、选中连线一致的 FlowingDot 流光动画，保证视觉统一。
 * 必须置于 <ReactFlow> 内部（依赖 ViewportPortal 跟随视口变换）。
 */
"use client";

import { getBezierPath, Position, ViewportPortal } from "@xyflow/react";

import { DOT_COLOR, FlowingDots } from "./EdgeFlow";

interface Props {
  /** 发起端 Handle 锚点（画布坐标） */
  from: { x: number; y: number };
  /** 终点：菜单弹出位置 / 鼠标落点（画布坐标） */
  to: { x: number; y: number };
  /** 起点 Handle 朝向：source = 右侧输出，target = 左侧输入 */
  fromPosition: Position;
}

export default function PendingConnectionPreview({ from, to, fromPosition }: Props) {
  const targetPosition = fromPosition === Position.Right ? Position.Left : Position.Right;

  const [edgePath] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: fromPosition,
    targetX: to.x,
    targetY: to.y,
    targetPosition,
  });

  return (
    <ViewportPortal>
      <svg style={{ position: "absolute", overflow: "visible", pointerEvents: "none" }}>
        <path
          d={edgePath}
          fill="none"
          style={{ stroke: DOT_COLOR, strokeWidth: 2 }}
        />
        <FlowingDots path={edgePath} color={DOT_COLOR} />
      </svg>
    </ViewportPortal>
  );
}
