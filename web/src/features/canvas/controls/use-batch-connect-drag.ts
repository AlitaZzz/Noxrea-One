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
 * - 拖回参与集内（自己的成员/选中节点）或移动过小 → 取消；只有越过误触阈值
 *   才进入 connecting（单击不触发组表面降透明）。
 * - 只跟踪起始指针：多指触控时其他指针的 move/up/cancel 不参与本次拖拽。
 * - 窗口失焦（blur）按取消处理：失焦后浏览器可能不再派发 pointerup /
 *   pointercancel，会话必须自行收尾，避免 connecting 常驻与过期会话补提交。
 * 拖动中的预览为束线：每个参与节点近端边缘正中出一根流光线汇到指针（与松手
 * 每节点建一条边一致，不画从 Handle 出发的单线）。
 * 拖动中的目标反馈与节点轨道拖线同款（connection-tilt 倾斜/毛玻璃），
 * 可连性与落点判定共用 connection-rules 的「会产生新边」口径；命中测试用
 * node-hit-test（几何口径，与 ConnectionFlowLine / handleConnectEnd 一致）。
 */
"use client";

import { useEffect, useRef, useState } from "react";

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

/** 进入拖拽的位移阈值（px）：与松手误触判定同源，单击不进入 connecting。 */
const DRAG_START_THRESHOLD_PX = 4;

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
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  /** 当前会话的结束函数；只清理非 React 副作用，消费者卸载时据此结束会话。 */
  const endSessionRef = useRef<(() => void) | null>(null);

  // 拖拽中消费者可能被卸载（Escape 清空选区、组节点删除等）：必须结束会话，
  // 否则残留的 window 监听会在卸载后按落点调用 onConnect / onConnectToBlank。
  // 卸载只结束会话，不重置组件本地状态（预览随组件一起销毁）。
  useEffect(() => () => endSessionRef.current?.(), []);

  function startDrag(e: React.PointerEvent) {
    // 重入保护：多指触控时第二个 pointerdown 会覆盖 dragRef 并叠加第二套
    // window 监听，首次 pointerup 即误清整个拖拽状态——已有拖拽进行中则忽略
    if (dragRef.current) return;
    // 只接受主指针的左键：右键/中键按下不进入拖拽，也不拦截浏览器默认行为
    if (!e.isPrimary || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const participantIds = getParticipantIds();
    // 束线起点在参与节点的近端边缘：扇出走右缘、扇入走左缘
    const anchorSide = direction === "output" ? "right" : "left";
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };

    /** 越过误触阈值后才真正进入拖拽：此时才进入 connecting、生成预览束线 */
    let started = false;
    /** 进入拖拽会话（connecting）；与预览束线分离，pointerup 补判时只需状态成对 */
    function enterConnecting() {
      started = true;
      onDragStart();
    }
    function beginDrag(to: { x: number; y: number }) {
      enterConnecting();
      const nodeById = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n] as const));
      const sources = participantIds
        .map((id) => nodeById.get(id))
        .flatMap((n) => {
          const a = n ? nodeEdgeAnchor(n, anchorSide, nodeById) : null;
          return a ? [a] : [];
        });
      setPreview({ sources, to });
    }

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
      const byId = new Map(state.nodes.map((n) => [n.id, n] as const));
      const box = hit ? getNodeBox(hit, byId) : null;
      if (!hit || !box) {
        clearConnectionTilt();
        return;
      }
      // 判定与落点同口径：对端在参与集内（拖回选区/自己组成员 = 取消）
      // 或任一参与节点类型不可连都产生空对集 → blocked；已连全重复同样 blocked
      const participants = participantIds.flatMap((id) => {
        const n = byId.get(id);
        return n ? [n] : [];
      });
      const connectable = pairsWouldCreate(buildPairs(participants, hit), state.edges);
      applyConnectionTilt({ id: hit.id, box }, to, connectable ? "ok" : "blocked");
    }

    /**
     * 结束会话：只做非 React 副作用——摘监听、清除倾斜、复位 dragRef 与结束函数
     * 引用，进入过 connecting 时补 onDragEnd。返回本次调用是否真正结束了会话。
     * pointerup / pointercancel / 窗口失焦 / 失键 move / 组件卸载都会触发，必须幂等。
     */
    let ended = false;
    function endSession(): boolean {
      if (ended) return false;
      ended = true;
      endSessionRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      clearConnectionTilt();
      dragRef.current = null;
      // 只有真正开始的拖拽才需要复位 connecting——单击不应触发状态往返
      if (started) onDragEnd();
      return true;
    }
    /**
     * 事件路径的统一清理：结束会话并清空预览。预览是组件本地状态，卸载路径
     * 不经过这里——组件已不存在，无需也不应重置。
     */
    const cleanupDrag = () => {
      if (endSession()) setPreview(null);
    };
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      // 只跟踪起始指针：多指触控时其他手指的 move 不参与本次拖拽
      if (!drag || ev.pointerId !== drag.pointerId) return;
      // 起始左键已松开（例如左右键和弦后先松左键）：按取消处理，
      // 避免预览继续跟随、或最终由非左键的 pointerup 提交
      if ((ev.buttons & 1) === 0) {
        cleanupDrag();
        return;
      }
      // 未越过误触阈值：不进入 connecting、不画预览束线
      if (!started) {
        const moved = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
        if (moved < DRAG_START_THRESHOLD_PX) return;
      }
      const to = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      if (started) {
        setPreview((p) => (p ? { ...p, to } : p));
      } else {
        beginDrag(to);
      }
      feedbackAt(to);
    };
    const onUp = (ev: PointerEvent) => {
      const drag = dragRef.current;
      // 其他指针的抬起不结束本次拖拽
      if (!drag || ev.pointerId !== drag.pointerId) return;
      // pointerup 只在最后一个按键松开时触发；非左键收尾（如左右键和弦后
      // 松开右键）视为取消，不按落点建边/弹菜单
      if (ev.button !== 0) {
        cleanupDrag();
        return;
      }

      const moved = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
      // 移动过小视为误触，取消（避免单击 Handle 就弹菜单）
      if (moved < DRAG_START_THRESHOLD_PX) {
        cleanupDrag();
        return;
      }

      const to = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      // 快速甩动可能把越过阈值的位移合并进 pointerup（最后一次 move 仍在
      // 阈值内）：补进 connecting 会话，保持 onDragStart/onDragEnd 成对且不丢连接。
      // 手势立即结束，不生成预览束线。
      if (!started) enterConnecting();
      cleanupDrag();

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
        // 菜单期间的束线预览由 CanvasOverlays 按 sourceNodeIds 逐节点渲染
        onConnectToBlank(participantIds, to, { x: ev.clientX, y: ev.clientY }, direction);
      }
    };
    // 触摸被系统中断（pointercancel）：只清理，不按落点处理——否则预览线与倾斜反馈会残留在画面上；
    // 其他指针的 cancel 不影响本次拖拽
    const onCancel = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      cleanupDrag();
    };
    // 窗口失焦（切标签页 / Alt+Tab / 窗口外松手）：浏览器可能不再派发
    // pointerup / pointercancel，按取消处理——批量连线的提交即建边，落点
    // 语义已不可信，与 marquee 的失焦取消一致；不做 resize 式的末帧提交。
    const onBlur = () => cleanupDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    endSessionRef.current = endSession;
  }

  return { startDrag, preview };
}
