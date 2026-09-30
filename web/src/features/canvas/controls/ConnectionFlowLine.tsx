/**
 * 拖拽连接时的自定义预览线组件。
 * 渲染中性灰贝塞尔预览线（与已建立连线同色），并叠加绿色管道流光动画；
 * 发起节点处于多选集合时，其余选中节点各补一根束线汇到同一终点（扇出预览，
 * 与松手「每选中节点建一条边」一致）；
 * 同时驱动目标节点的倾斜/可行性反馈（流动描边 = 可连，毛玻璃 = 不可连，见 ./connection-tilt.ts）。
 */
"use client";

import { BaseEdge, type ConnectionLineComponentProps,getBezierPath, Position } from "@xyflow/react";
import { Fragment, useEffect } from "react";

import { connectionWouldCreate } from "@/features/canvas/shared/connection-rules";
import { buildNodeIndex } from "@/features/canvas/shared/group-bounds";
import { findNodeAtFlowPoint, getNodeBox, nodeEdgeAnchor } from "@/features/canvas/shared/node-hit-test";
import { getLiveViewport, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { EDGE_BASE_COLOR, insetHandleCenter, NODE_TYPE } from "@/lib/constants";

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
    // 几何判定统一在绝对坐标空间（成员 position 是组内相对坐标）
    const nodeById = buildNodeIndex(nodes);
    const sourceType = nodeById.get(fromNodeId ?? "")?.type;
    if (!sourceType) {
      clearConnectionTilt();
      return;
    }
    // 磁吸命中：指针已吸到某节点的轨道上，以轨道判定为准（toNode 在 valid/invalid 时都有值）：
    //   valid：通过合法性校验（xyflow 对反向拖拽已交换 source/target，方向语义正确）——
    //          朝指针方位倾斜 + 流动描边；
    //   invalid：吸上了但不可连——蒙毛玻璃。不能漏给悬停循环，否则吸在类型可连
    //          但轨道同侧的节点上会给出 ok 描边，松手却连不上。合法性来自应用
    //          的 isValidConnection（connection-rules 口径：类型 / 自连 / 已连去重
    //          / 多选扇出全有或全无聚合），此处再兜一道源 === 目标排除。
    if (toNodeId && connectionStatus !== null) {
      const n = nodeById.get(toNodeId);
      const box = n ? getNodeBox(n, nodeById) : null;
      if (n && box) {
        const connectable = connectionStatus === "valid" && n.id !== fromNodeId;
        applyConnectionTilt(
          { id: n.id, box },
          { x: flowX, y: flowY },
          connectable ? "ok" : "blocked"
        );
        return;
      }
    }
    // 未磁吸：指针进入节点区域时反馈，只认指针正下方的最上层节点（与松手时的
    // 建边判定共用同一命中测试）。可连性直接用 connection-rules 的「会产生新边」
    // 判定（类型 / 自连 / 已连 / 多选扇出同口径），源节点自身也在候选内——拖出后
    // 悬回源节点时自连不可行，给 blocked 毛玻璃而非无反馈
    const hit = findNodeAtFlowPoint(nodes, { x: flowX, y: flowY });
    if (hit) {
      const { edges } = useCanvasStore.getState();
      const connectable =
        !!fromNodeId &&
        connectionWouldCreate(
          isReverseDrag ? hit.id : fromNodeId,
          isReverseDrag ? fromNodeId : hit.id,
          { nodes, edges }
        );
      const box = getNodeBox(hit, nodeById)!;
      applyConnectionTilt(
        { id: hit.id, box },
        { x: flowX, y: flowY },
        connectable ? "ok" : "blocked"
      );
      return;
    }
    clearConnectionTilt();
  }, [fromNodeId, pointerX, pointerY, connectionStatus, toNodeId, isReverseDrag]);
  useEffect(() => () => clearConnectionTilt(), []);

  // 多选扇出的束线预览：发起节点处于多选集合（≥2 非组节点）时，其余选中节点
  // 也各出一根流光线汇到同一终点——与松手「每选中节点建一条边」一致（正向拖拽
  // 从右缘出线、反向拖拽从左缘出线）。单选或发起节点未入选时无束线。
  // 选中集与节点位置在拖线期间不变，直接在渲染时读取即可（组件每帧随指针重渲染）。
  const bundlePaths: string[] = [];
  if (fromNode?.id && fromNode.selected) {
    const side = isReverseDrag ? "left" : "right";
    const bundleEnd = toPosition ?? (fromPosition === Position.Right ? Position.Left : Position.Right);
    const bundleNodes = useCanvasStore.getState().nodes;
    const bundleById = buildNodeIndex(bundleNodes);
    for (const n of bundleNodes) {
      if (!n.selected || n.type === NODE_TYPE.GROUP || n.id === fromNode.id) continue;
      const a = nodeEdgeAnchor(n, side, bundleById);
      if (!a) continue;
      const [p] = getBezierPath({
        sourceX: a.x,
        sourceY: a.y,
        sourcePosition: isReverseDrag ? Position.Left : Position.Right,
        targetX: target.x,
        targetY: target.y,
        targetPosition: bundleEnd,
      });
      bundlePaths.push(p);
    }
  }

  return (
    <>
      <BaseEdge path={edgePath} style={{ stroke: EDGE_BASE_COLOR, strokeWidth: 2 }} />
      <FlowLines path={edgePath} color={DOT_COLOR} />
      {bundlePaths.map((p, i) => (
        <Fragment key={i}>
          <BaseEdge path={p} style={{ stroke: EDGE_BASE_COLOR, strokeWidth: 2 }} />
          <FlowLines path={p} color={DOT_COLOR} />
        </Fragment>
      ))}
    </>
  );
}
