/**
 * 批量连线拖拽逻辑（双向）：从「参与集」整体拖线接到目标。
 * 两个消费者共用同一实现，只差外壳渲染：
 * - BatchConnectHandle（框选外框）：ViewportPortal 内的条带+圆点轨道，常显，
 *   输出方向（参与集 → 目标）；
 * - GroupConnectRail（组节点左/右缘）：渲染在组节点 DOM 内的连接轨道，
 *   显隐走标准 Handle 规则（hover / 选中 / 按住），右缘扇出、左缘扇入。
 *
 * 拖线语义（全有或全无，connection-rules 口径）：
 * - 拖到已有节点 → buildFanoutPairs / buildFanInPairs 批量建对，任一参与
 *   节点与对端类型不可连即整体拒绝，候选对交父级 onConnect 完成建边与去重；
 * - 拖到空白 → 与单节点连线一致，弹出「创建连接节点」菜单，批量接驳；
 * - 拖回参与集内（自己的成员/选中节点）或移动过小 → 取消。
 * 拖动中的预览为束线：每个参与节点近端边缘正中出一根流光线汇到指针（与松手
 * 每节点建一条边一致，不画从 Handle 出发的单线）。
 * 拖动中的目标反馈与节点轨道拖线同款（connection-tilt 倾斜/毛玻璃），
 * 可连性与落点判定共用 connection-rules 的「会产生新边」口径；命中测试用
 * node-hit-test（几何口径，与 ConnectionFlowLine / handleConnectEnd 一致）。
 */
"use client";

import { useRef, useState } from "react";

import {
  buildFanInPairs,
  buildFanoutPairs,
  pairsWouldCreate,
} from "@/features/canvas/shared/connection-rules";
import { findNodeAtFlowPoint, getNodeBox, nodeEdgeAnchor } from "@/features/canvas/shared/node-hit-test";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

import { applyConnectionTilt, clearConnectionTilt } from "./connection-tilt";

export type BatchDirection = "output" | "input";

/** 束线预览：每根线从各参与节点近端边缘正中出发，汇到指针位置（画布坐标） */
export interface BatchDragPreview {
  sources: { x: number; y: number }[];
  to: { x: number; y: number };
}

interface Params {
  /** 拖线方向：output = 参与集 → 目标（扇出）；input = 目标 → 参与集（扇入） */
  direction: BatchDirection;
  /** 拖起时求值参与集节点 id：框选 = 选中节点 id 闭包；组 = 从 store 现取组成员
   *  （成员随时增减，渲染层不镜像成员列表） */
  getParticipantIds: () => string[];
  /** 松手建边：候选对由本 Hook 按方向构建（全有或全无），父级完成建边与去重 */
  onConnect: (pairs: { source: string; target: string }[]) => void;
  onConnectToBlank: (
    participantIds: string[],
    canvasPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
    direction: BatchDirection
  ) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
}

export function useBatchConnectDrag({
  direction,
  getParticipantIds,
  onConnect,
  onConnectToBlank,
  onDragStart,
  onDragEnd,
  screenToFlowPosition,
}: Params) {
  const [preview, setPreview] = useState<BatchDragPreview | null>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);

  function startDrag(e: React.PointerEvent) {
    // 重入保护：多指触控时第二个 pointerdown 会覆盖 dragRef 并叠加第二套
    // window 监听，首次 pointerup 即误清整个拖拽状态——已有拖拽进行中则忽略
    if (dragRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    const participantIds = getParticipantIds();
    // 束线起点在参与节点的近端边缘：扇出走右缘、扇入走左缘
    const anchorSide = direction === "output" ? "right" : "left";
    dragRef.current = { startX: e.clientX, startY: e.clientY };
    onDragStart();
    const nodeById = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n]));
    const sources = participantIds
      .map((id) => nodeById.get(id))
      .flatMap((n) => {
        const a = n ? nodeEdgeAnchor(n, anchorSide) : null;
        return a ? [a] : [];
      });
    setPreview({ sources, to: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });

    /** 按方向构建候选对（反馈与松手建边共用，保证口径一致） */
    function buildPairs(participants: AnyNode[], hit: AnyNode): { source: string; target: string }[] {
      return direction === "output"
        ? buildFanoutPairs(participants, hit)
        : buildFanInPairs(hit, participants);
    }

    /** 拖动中的目标反馈：命中节点给 ok/blocked 倾斜，判定与松手建边同口径 */
    function feedbackAt(to: { x: number; y: number }) {
      const state = useCanvasStore.getState();
      const hit = findNodeAtFlowPoint(state.nodes, to);
      const box = hit ? getNodeBox(hit) : null;
      if (!hit || !box) {
        clearConnectionTilt();
        return;
      }
      // 判定与落点同口径：对端在参与集内（拖回选区/自己组成员 = 取消）
      // 或任一参与节点类型不可连都产生空对集 → blocked；已连全重复同样 blocked
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const participants = participantIds.flatMap((id) => {
        const n = byId.get(id);
        return n ? [n] : [];
      });
      const connectable = pairsWouldCreate(buildPairs(participants, hit), state.edges);
      applyConnectionTilt({ id: hit.id, box }, to, connectable ? "ok" : "blocked");
    }

    /** 结束拖拽的统一清理：摘监听、清预览线与倾斜反馈、复位交互状态 */
    const cleanupDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setPreview(null);
      clearConnectionTilt();
      dragRef.current = null;
      onDragEnd();
    };
    const onMove = (ev: PointerEvent) => {
      const to = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      setPreview((p) => (p ? { ...p, to } : p));
      feedbackAt(to);
    };
    const onUp = (ev: PointerEvent) => {
      const drag = dragRef.current;
      cleanupDrag();
      if (!drag) return;

      // 移动过小视为误触，取消（避免单击 Handle 就弹菜单）
      const moved = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
      if (moved < 4) return;

      const to = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const hit = findNodeAtFlowPoint(useCanvasStore.getState().nodes, to);

      if (hit && !participantIds.includes(hit.id)) {
        const state = useCanvasStore.getState();
        const byId = new Map(state.nodes.map((n) => [n.id, n]));
        const participants = participantIds.flatMap((id) => {
          const n = byId.get(id);
          return n ? [n] : [];
        });
        onConnect(buildPairs(participants, hit));
      } else if (!hit) {
        // 空白处弹创建菜单（命中参与节点 = 拖回参与集，视为取消）。
        // 菜单期间的束线预览由 InfiniteCanvas 按 sourceNodeIds 逐节点渲染
        onConnectToBlank(participantIds, to, { x: ev.clientX, y: ev.clientY }, direction);
      }
    };
    // 触摸被系统中断（pointercancel）：只清理，不按落点处理——否则预览线与倾斜反馈会残留在画面上
    const onCancel = () => cleanupDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return { startDrag, preview };
}
