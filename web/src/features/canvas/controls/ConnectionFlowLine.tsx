/**
 * 拖拽连接时的自定义预览线组件。
 * 渲染中性灰贝塞尔预览线（与已建立连线同色），并叠加绿色管道流光动画；
 * 同时驱动目标节点的倾斜/可行性反馈（流动描边 = 可连，毛玻璃 = 不可连，见 ./connection-tilt.ts）。
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
  fromHandle,
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

  // 连线拖动中，目标节点给出正交于倾斜方向的可行性反馈（命令式写 DOM/classList，
  // 不触发 React 渲染，见 ./connection-tilt.ts）。磁吸优先：
  // 1. 线已磁吸到某节点轨道（connectionStatus === 'valid'）——意图已锁定，
  //    即使指针在节点外侧，目标节点也朝指针方位倾斜（偏移钳到边缘取最大角）；
  // 2. 指针落在节点区域内——只认指针正下方最上层的节点：可连则倾斜+流动描边，
  //    不可连（含悬停源节点自身=自连）则覆盖毛玻璃蒙层。两者互斥。
  // 两者皆不满足即复位。
  const fromNodeId = fromNode?.id;
  const toNodeId = toNode?.id;
  // 反向拖拽：从目标轨道（输入轨）拖出，连接方向与常规相反——悬停节点是未来的源
  const isReverseDrag = fromHandle?.type === "target";
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
    // 磁吸命中：指针已吸到某节点的轨道上，以轨道判定为准（toNode 在 valid/invalid 时都有值）：
    //   valid：通过合法性校验（xyflow 对反向拖拽已交换 source/target，方向语义正确）——
    //          朝指针方位倾斜 + 流动描边；
    //   invalid：吸上了但不可连（同侧轨道 / 类型不匹配）——蒙毛玻璃。不能漏给悬停循环，
    //          否则吸在类型可连但轨道同侧的节点上会给出 ok 描边，松手却连不上；
    // 自连例外：xyflow 的严格模式不排除同节点的另一条轨道，且应用的 isValidConnection
    // 只按类型判断——源 === 目标时自连不可行，同样降级为 blocked
    if (toNodeId && connectionStatus !== null) {
      const n = nodes.find((m) => m.id === toNodeId);
      const width = n && typeof n.style?.width === "number" ? n.style.width : 0;
      const height = n && typeof n.style?.height === "number" ? n.style.height : 0;
      if (n && width > 0 && height > 0) {
        const connectable = connectionStatus === "valid" && n.id !== fromNodeId;
        applyConnectionTilt(
          { id: n.id, box: { x: n.position.x, y: n.position.y, width, height } },
          { x: flowX, y: flowY },
          connectable ? "ok" : "blocked"
        );
        return;
      }
    }
    // 未磁吸：指针进入节点区域时反馈，数组靠后的节点绘制在上层，自上而下找第一个命中。
    // 源节点自身也在候选内——拖出后悬回源节点（典型如反向从输入轨道拖出）时指针就在
    // 源节点上，此时自连不可行，给 blocked 毛玻璃而非无反馈
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const width = typeof n.style?.width === "number" ? n.style.width : 0;
      const height = typeof n.style?.height === "number" ? n.style.height : 0;
      if (width <= 0 || height <= 0) continue;
      if (
        flowX < n.position.x || flowX > n.position.x + width ||
        flowY < n.position.y || flowY > n.position.y + height
      ) continue;
      const connectable =
        n.id !== fromNodeId &&
        (isReverseDrag ? canConnect(n.type, sourceType) : canConnect(sourceType, n.type));
      applyConnectionTilt(
        { id: n.id, box: { x: n.position.x, y: n.position.y, width, height } },
        { x: flowX, y: flowY },
        connectable ? "ok" : "blocked"
      );
      return;
    }
    clearConnectionTilt();
  }, [fromNodeId, pointerX, pointerY, connectionStatus, toNodeId, isReverseDrag]);
  useEffect(() => () => clearConnectionTilt(), []);

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: EDGE_BASE_COLOR, strokeWidth: 2 }} />
      <FlowLines path={edgePath} color={DOT_COLOR} />
    </>
  );
}
