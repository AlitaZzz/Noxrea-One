/**
 * 拖拽连接时的自定义预览线组件。
 * 渲染中性灰贝塞尔预览线（与已建立连线同色），并叠加绿色管道流光动画；
 * 同时驱动「指针在节点区域内跟随倾斜」的反馈（见 ./connection-tilt.ts）。
 */
"use client";

import { BaseEdge, type ConnectionLineComponentProps,getBezierPath, Position } from "@xyflow/react";
import { useEffect } from "react";

import { getLiveViewport, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { canConnect, EDGE_BASE_COLOR, insetHandleCenter } from "@/lib/constants";

import { applyConnectionTilt, clearConnectionTilt } from "./connection-tilt";
import { DOT_COLOR, FlowLines } from "./EdgeFlow";

export default function ConnectionFlowLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
  fromNode,
  toNode,
  pointer,
}: ConnectionLineComponentProps) {
  // 起点为源轨道中心，收回节点边缘（连线锚点恒为节点边缘垂直正中，圆点跟随只是视觉反馈）；
  // 终点：吸附到目标轨道时（connectionStatus === 'valid'）toX/toY 为轨道中心，同样收回贴到节点边缘；
  // 否则是鼠标实时位置，保持不动
  const source = insetHandleCenter(fromPosition, fromX, fromY);
  const target = connectionStatus === "valid" ? insetHandleCenter(toPosition ?? undefined, toX, toY) : { x: toX, y: toY };

  const [edgePath] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: fromPosition,
    targetX: target.x,
    targetY: target.y,
    targetPosition: toPosition ?? (fromPosition === Position.Right ? Position.Left : Position.Right),
  });

  // 连线拖动中，目标节点跟随鼠标连续倾斜（命令式写 DOM，不触发 React 渲染，
  // 见 ./connection-tilt.ts）。两个触发条件，磁吸优先：
  // 1. 线已磁吸到某节点轨道（connectionStatus === 'valid'）——意图已锁定，
  //    即使指针在节点外侧，目标节点也朝指针方位倾斜（偏移钳到边缘取最大角）；
  // 2. 指针落在节点区域内——只认指针正下方最上层的节点，且连线合法（canConnect）。
  // 不可连的节点保持平整避免误导；两者皆不满足即复位。
  const fromNodeId = fromNode?.id;
  const toNodeId = toNode?.id;
  const pointerX = pointer.x;
  const pointerY = pointer.y;
  useEffect(() => {
    // xyflow connection state 的 pointer 是容器屏幕坐标（getEventPosition），
    // 节点 position 是 flow 坐标，需先经视口 transform 换算：flow = (screen - t) / zoom
    const vp = getLiveViewport();
    const zoom = vp.zoom > 0.01 ? vp.zoom : 1;
    const flowX = (pointerX - vp.x) / zoom;
    const flowY = (pointerY - vp.y) / zoom;
    const { nodes } = useCanvasStore.getState();
    const sourceType = nodes.find((n) => n.id === fromNodeId)?.type;
    if (!sourceType) {
      clearConnectionTilt();
      return;
    }
    // 磁吸命中：valid 已通过合法性校验，直接朝指针方位倾斜
    if (connectionStatus === "valid" && toNodeId) {
      const n = nodes.find((m) => m.id === toNodeId);
      const width = n && typeof n.style?.width === "number" ? n.style.width : 0;
      const height = n && typeof n.style?.height === "number" ? n.style.height : 0;
      if (n && width > 0 && height > 0) {
        applyConnectionTilt(
          { id: n.id, box: { x: n.position.x, y: n.position.y, width, height } },
          { x: flowX, y: flowY }
        );
        return;
      }
    }
    // 未磁吸：指针进入节点区域时倾斜，数组靠后的节点绘制在上层，自上而下找第一个命中
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.id === fromNodeId) continue;
      const width = typeof n.style?.width === "number" ? n.style.width : 0;
      const height = typeof n.style?.height === "number" ? n.style.height : 0;
      if (width <= 0 || height <= 0) continue;
      if (
        flowX < n.position.x || flowX > n.position.x + width ||
        flowY < n.position.y || flowY > n.position.y + height
      ) continue;
      if (canConnect(sourceType, n.type)) {
        applyConnectionTilt(
          { id: n.id, box: { x: n.position.x, y: n.position.y, width, height } },
          { x: flowX, y: flowY }
        );
      } else {
        clearConnectionTilt();
      }
      return;
    }
    clearConnectionTilt();
  }, [fromNodeId, pointerX, pointerY, connectionStatus, toNodeId]);
  useEffect(() => () => clearConnectionTilt(), []);

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: EDGE_BASE_COLOR, strokeWidth: 2 }} />
      <FlowLines path={edgePath} color={DOT_COLOR} />
    </>
  );
}
