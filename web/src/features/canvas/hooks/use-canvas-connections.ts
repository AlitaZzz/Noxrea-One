/**
 * 连线交互域 hook：松手建边、批量建边、拖线到空白的创建菜单与预览线。
 *
 * 所有合法性判定共用 `shared/connection-rules` 的「会产生新边」口径：
 * 多选扇出为全有或全无，自连 / 已连 / 类型不匹配整体拒绝。事件处理器读取
 * store 实时状态，避免渲染期闭包中的节点列表过期。
 */
"use client";

import type { Connection, Edge, FinalConnectionState } from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { BatchConnectHandlers } from "@/features/canvas/controls/BatchConnectContext";
import type { PendingConnectionCreate } from "@/features/canvas/controls/ConnectionCreateMenu";
import {
  createAudioNode,
  createEdge,
  createImageNode,
  createTextNode,
  createVideoNode,
} from "@/features/canvas/node-defaults";
import {
  buildConnectionPairs,
  buildFanInPairs,
  buildFanoutPairs,
  connectionWouldCreate,
} from "@/features/canvas/shared/connection-rules";
import {
  buildNodeIndex,
  findGroupAtPoint,
  refitGroupRects,
} from "@/features/canvas/shared/group-bounds";
import { findNodeAtFlowPoint, nodeEdgeAnchor } from "@/features/canvas/shared/node-hit-test";
import { bumpRefOrderToTail } from "@/features/canvas/shared/ref-order";
import {
  markDirtyImmediate,
  useCanvasStore,
  withHistoryBatch,
} from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

// 无待定连线时的稳定空锚点：程序化位置帧逐帧重渲染本组件，返回字面量 [] 会让
// pendingPreviewAnchors 每次都是新引用。只读、由使用方 map，不做原地修改。
const NO_PENDING_PREVIEW_ANCHORS: readonly { x: number; y: number }[] = [];

export interface UseCanvasConnectionsOptions {
  /** 渲染期节点列表：只用于计算待创建连线的预览锚点，不进入事件回调。 */
  nodes: AnyNode[];
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  onConnectStart: () => void;
  onConnectEnd: () => void;
}

export function useCanvasConnections({
  nodes,
  screenToFlowPosition,
  onConnectStart,
  onConnectEnd,
}: UseCanvasConnectionsOptions) {
  const setEdges = useCanvasStore((s) => s.setEdges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const addNodes = useCanvasStore((s) => s.addNodes);

  /** 批量建边：去重已存在的连线，新边统一触发参考置尾与落库 */
  const batchConnect = useCallback(
    (pairs: { source: string; target: string }[]) => {
      if (pairs.length === 0) return;
      const state = useCanvasStore.getState();
      const existing = new Set(state.edges.map((e) => `${e.source}->${e.target}`));
      const fresh = pairs
        .filter((p) => !existing.has(`${p.source}->${p.target}`))
        .map((p) => createEdge(p.source, p.target));
      if (fresh.length === 0) return;
      // 连线是离散操作：必定压栈（不再依赖节流窗口）
      setEdges([...state.edges, ...fresh], { forceHistory: true });
      bumpRefOrderToTail(fresh);
      markDirtyImmediate();
    },
    [setEdges],
  );

  const handleConnect = useCallback(
    (connection: Pick<Connection, "source" | "target">) => {
      if (!connection.source || !connection.target) return;
      // 扇出语义、类型校验与自连排除统一在 buildConnectionPairs（见 shared/connection-rules）
      const pairs = buildConnectionPairs(
        connection.source,
        connection.target,
        useCanvasStore.getState().nodes,
      );
      batchConnect(pairs);
    },
    [batchConnect],
  );

  // 节点连接规则：xyflow 拖线磁吸时的合法性判定（connectionStatus / 松手 onConnect 的开关）。
  // 与松手建边、拖拽反馈共用 connection-rules 的「会产生新边」口径：多选扇出为全有或
  // 全无——全部选中节点与对端类型可连（任一不可连即整体拒绝）且至少产生一条新边
  // 才合法，全部已连 / 自连也不合法——不会出现「显示可连却建不出边」或自环边。
  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const srcId = connection.source;
    const tgtId = connection.target;
    if (!srcId || !tgtId) return true;
    const state = useCanvasStore.getState();
    const known =
      state.nodes.some((n) => n.id === srcId) && state.nodes.some((n) => n.id === tgtId);
    if (!known) return true;
    return connectionWouldCreate(srcId, tgtId, state);
  }, []);

  // ── 拖拽连线到空白处弹出「创建连接节点」菜单 ──
  const [pendingConnectionCreate, setPendingConnectionCreate] =
    useState<PendingConnectionCreate | null>(null);
  // 记录连接起始 Handle 类型（onConnectStart 提供，比 onConnectEnd 的 fromHandle.type 可靠）
  const connectStartHandleTypeRef = useRef<"source" | "target" | null>(null);

  const handleConnectStart = useCallback(
    (_: unknown, params: { handleType: "source" | "target" | null }) => {
      connectStartHandleTypeRef.current = params.handleType ?? null;
      onConnectStart();
    },
    [onConnectStart],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // 连接结束（成功或取消）复位交互状态
      onConnectEnd();
      // 由起始 Handle 的 type 判断连接方向：
      //   source = 从右侧输出 Handle 拖出 → 新节点为下游（output）
      //   target = 从左侧输入 Handle 拉入 → 新节点为上游（input）
      // 使用 onConnectStart 记录的 handleType（比 connectionState.fromHandle.type 更可靠）
      const direction: "input" | "output" =
        connectStartHandleTypeRef.current === "target" ? "input" : "output";
      connectStartHandleTypeRef.current = null;
      // 连接未磁吸到目标节点的轨道 Handle（toNode 为空）：可能落在节点本体或空白处，
      // 前者下方直接建边，后者弹出创建菜单
      const toNode = "toNode" in connectionState ? connectionState.toNode : null;
      if (toNode) return;

      const sourceNode = "fromNode" in connectionState ? connectionState.fromNode : null;
      if (!sourceNode) return;

      // 取鼠标/触摸的屏幕坐标
      let clientX = 0,
        clientY = 0;
      if ("changedTouches" in event && event.changedTouches.length > 0) {
        clientX = event.changedTouches[0].clientX;
        clientY = event.changedTouches[0].clientY;
      } else if ("clientX" in event) {
        clientX = event.clientX;
        clientY = event.clientY;
      }

      const canvasPosition = screenToFlowPosition({ x: clientX, y: clientY });

      // 松手落在节点本体（未磁吸到轨道）→ 不弹创建菜单：按「这次连接会不会产生
      // 新边」判定（connection-rules：多选扇出聚合 + 类型校验 + 自连/已连去重，
      // 与 isValidConnection、拖拽反馈同口径），可连则直接建边（走 handleConnect，
      // 继承扇出与置尾），否则静默取消——拖拽中的毛玻璃反馈已提示不可连。
      // 命中测试与 ConnectionFlowLine 的实时反馈共用 node-hit-test。
      const state = useCanvasStore.getState();
      const hit = findNodeAtFlowPoint(state.nodes, canvasPosition);
      if (hit) {
        const connection =
          direction === "output"
            ? { source: sourceNode.id, target: hit.id }
            : { source: hit.id, target: sourceNode.id };
        if (connectionWouldCreate(connection.source, connection.target, state)) {
          handleConnect(connection);
        }
        return;
      }

      // 落点为空白 → 弹创建菜单。预览线的锚点不再随状态存储，渲染时按
      // sourceNodeIds + direction 逐节点取边缘锚点（见 pendingPreviewAnchors）
      setPendingConnectionCreate({
        sourceNodeIds: [sourceNode.id],
        sourceNodeTypes: [sourceNode.type ?? ""],
        direction,
        canvasPosition,
        screenPosition: { x: clientX, y: clientY },
      });
    },
    [screenToFlowPosition, onConnectEnd, handleConnect],
  );

  const handleCreateConnectedNode = useCallback(
    (nodeType: string) => {
      if (!pendingConnectionCreate) return;
      const { sourceNodeIds, canvasPosition, direction } = pendingConnectionCreate;

      let newNode: AnyNode;
      switch (nodeType) {
        case NODE_TYPE.TEXT:
          newNode = createTextNode(canvasPosition);
          break;
        case NODE_TYPE.IMAGE:
          newNode = createImageNode(canvasPosition);
          break;
        case NODE_TYPE.VIDEO:
          newNode = createVideoNode(canvasPosition);
          break;
        case NODE_TYPE.AUDIO:
          newNode = createAudioNode(canvasPosition);
          break;
        default:
          return;
      }

      // 落点创建即归组：与拖入归组同规则「包含即归属」（group-bounds）。
      // 菜单创建是唯一不经过 drag stop 归属判定的放置入口，此前组内落点
      // 建节点会落在组里却不归属（不随组移动、不算成员）。
      // 以新节点中心点判定（媒体节点加载前无实测尺寸，中心 ≈ 落点本身）
      const newW = Number(newNode.style?.width) || 0;
      const newH = Number(newNode.style?.height) || 0;
      const joinedGroupId = findGroupAtPoint(useCanvasStore.getState().nodes, {
        x: newNode.position.x + newW / 2,
        y: newNode.position.y + newH / 2,
      });
      if (joinedGroupId) {
        const group = useCanvasStore
          .getState()
          .nodes.find((n) => n.id === joinedGroupId);
        if (group) {
          // 归组：绝对落点换算为组内相对坐标 + parentId 结构关系
          newNode = {
            ...newNode,
            parentId: joinedGroupId,
            position: {
              x: newNode.position.x - group.position.x,
              y: newNode.position.y - group.position.y,
            },
          } as AnyNode;
        }
      }

      // 建节点 + 归组扩框 + 批量接线是同一原子操作：批量守卫合并为一条撤销
      //（addNodes 压入创建前快照，撤销一并回滚归组、扩框与接线）
      withHistoryBatch(() => {
        addNodes([newNode]);
        if (joinedGroupId) {
          setNodes(refitGroupRects(useCanvasStore.getState().nodes, [joinedGroupId]));
          markDirtyImmediate();
        }
        // 批量接线与菜单门控同口径（全有或全无，connection-rules）：
        // 输出方向 buildFanoutPairs（各选中 → 新节点），输入方向 buildFanInPairs（新节点 → 各选中）
        const nodeById = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n]));
        const participants = sourceNodeIds
          .map((id) => nodeById.get(id))
          .filter((n): n is AnyNode => !!n);
        const pairs =
          direction === "output"
            ? buildFanoutPairs(participants, newNode)
            : buildFanInPairs(newNode, participants);
        batchConnect(pairs);
      });
    },
    [pendingConnectionCreate, addNodes, batchConnect, setNodes],
  );

  /** 菜单期间的束线预览锚点：按 sourceNodeIds 逐节点取右/左边缘正中
   *  （多选扇出每个选中节点一根，单节点即一根），无有效盒尺寸的节点跳过。
   *  锚点统一在绝对坐标空间计算（成员 position 是组内相对坐标） */
  const pendingPreviewAnchors = useMemo(() => {
    if (!pendingConnectionCreate) return NO_PENDING_PREVIEW_ANCHORS;
    const nodeById = buildNodeIndex(nodes);
    const side = pendingConnectionCreate.direction === "output" ? "right" : "left";
    return pendingConnectionCreate.sourceNodeIds
      .map((id) => nodeById.get(id))
      .flatMap((n) => {
        const anchor = n ? nodeEdgeAnchor(n, side, nodeById) : null;
        return anchor ? [anchor] : [];
      });
  }, [pendingConnectionCreate, nodes]);

  /** 批量 Handle 拖到空白：弹出「创建连接节点」菜单，创建后批量接驳全部参与节点
   *  （框选 = 选中节点，组 = 组成员；菜单按参与类型全有或全无门控选项，
   *  方向随拖线轨道：output 新节点在下游，input 新节点在上游） */
  const openBatchCreateMenu = useCallback(
    (
      participantIds: string[],
      canvasPosition: { x: number; y: number },
      screenPosition: { x: number; y: number },
      direction: "output" | "input",
    ) => {
      const selected = useCanvasStore
        .getState()
        .nodes.filter((n) => participantIds.includes(n.id));
      if (selected.length === 0) return;
      setPendingConnectionCreate({
        sourceNodeIds: selected.map((n) => n.id),
        sourceNodeTypes: selected.map((n) => n.type ?? ""),
        direction,
        canvasPosition,
        screenPosition,
      });
    },
    [],
  );

  /** 组节点批量轨道（GroupConnectRail）的接驳回调：渲染在节点 DOM 内，
   *  不能经 props 透传，也不能塞进持久化的 node data，经 Context 注入。
   *  onConnect 直接用 batchConnect——候选对已由 use-batch-connect-drag 按方向
   *  构建并全有或全无校验，这里只负责建边与去重 */
  const batchConnectHandlers = useMemo<BatchConnectHandlers>(
    () => ({
      onConnect: batchConnect,
      onConnectToBlank: openBatchCreateMenu,
      onDragStart: onConnectStart,
      onDragEnd: onConnectEnd,
      screenToFlowPosition,
    }),
    [batchConnect, openBatchCreateMenu, onConnectStart, onConnectEnd, screenToFlowPosition],
  );

  const closeConnectionCreate = useCallback(() => setPendingConnectionCreate(null), []);

  return {
    handleConnect,
    handleConnectStart,
    handleConnectEnd,
    isValidConnection,
    pendingConnectionCreate,
    pendingPreviewAnchors,
    handleCreateConnectedNode,
    closeConnectionCreate,
    batchConnectHandlers,
  };
}
