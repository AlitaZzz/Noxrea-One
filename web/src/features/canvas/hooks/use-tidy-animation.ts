/**
 * 节点位置缓动动画。
 * 在给定时长内用 requestAnimationFrame 插值，把节点从当前位置移动到目标位置。
 *
 * 设计要点：
 * - 每帧只替换 position 字段，未参与移动的节点返回原引用，降低 React Flow 的 diff 成本
 * - 起点在动画开始时冻结，中途其它状态更新不会打乱插值基准
 * - 动画期间暴露模块级标志，用户一旦拖拽节点即可取消动画，
 *   避免动画写入与 React Flow 拖拽状态互相打架
 */
"use client";

import { useCallback, useEffect } from "react";

import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import { computeTidyLayout } from "@/features/canvas/shared/tidy-layout";
import { markDirtyImmediate, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { TIDY_ANIMATION_DURATION, TIDY_MAX_ANIMATED_NODES } from "@/lib/constants";

/** 是否正在播放整理动画（供画布交互判断是否需要让路） */
let _animating = false;

/** 当前活动动画的 rAF 句柄（模块级：同一时刻至多一个动画在跑，animateTo 会先取消上一个） */
let _activeRaf: number | null = null;

/** 读取动画进行中标志 */
export function isTidyAnimating(): boolean {
  return _animating;
}

/**
 * 停掉进行中的整理动画，节点停在当前插值位置。
 * 撤销/重做恢复快照前必须调用：动画每帧都在写节点位置，
 * 不停掉的话下一帧会把恢复出来的位置直接覆盖。
 */
export function cancelTidyAnimation(): void {
  if (_activeRaf !== null) {
    cancelAnimationFrame(_activeRaf);
    _activeRaf = null;
  }
  _animating = false;
}

/** easeOutCubic：起步快、收尾稳，位移类动画的常用曲线 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface AnimateNodesOptions {
  /** 动画时长（ms），<= 0 时直接落位 */
  duration?: number;
  /** 动画正常结束后的回调（被 cancel 时不会触发） */
  onDone?: () => void;
  /**
   * 程序化整理（agent 的 arrange_canvas）置 true：逐帧写入不进用户操作历史。
   * 动画可能被拖拽中途取消（onDone 不触发），因此按帧包裹而非整段包裹。
   */
  suppressTracking?: boolean;
}

/**
 * 模块级动画核心（供非 React 上下文调用，如共享编排 applyTidyLayout；
 * hook 的 animateTo 委托至此）。重复调用会自动取消上一次动画。
 */
export function animateNodesTo(
  targets: Map<string, { x: number; y: number }>,
  options: AnimateNodesOptions = {},
): void {
  cancelTidyAnimation();

  const { duration = 300, onDone } = options;
  const store = useCanvasStore.getState();

  // 冻结起点
  const from = new Map<string, { x: number; y: number }>();
  for (const n of store.nodes) {
    if (targets.has(n.id)) from.set(n.id, { x: n.position.x, y: n.position.y });
  }
  if (from.size === 0) {
    onDone?.();
    return;
  }

  const start = performance.now();
  _animating = true;

  const step = (now: number) => {
    const raw = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
    const t = easeOutCubic(raw);
    const current = useCanvasStore.getState().nodes;

    const next = current.map((n) => {
      const f = from.get(n.id);
      const to = targets.get(n.id);
      if (!f || !to) return n; // 引用不变，跳过 diff
      if (raw >= 1) return { ...n, position: to };
      return {
        ...n,
        position: { x: f.x + (to.x - f.x) * t, y: f.y + (to.y - f.y) * t },
      };
    });

    if (options.suppressTracking) {
      runSuppressed(() => useCanvasStore.getState().setNodes(next));
    } else {
      useCanvasStore.getState().setNodes(next);
    }

    if (raw < 1) {
      _activeRaf = requestAnimationFrame(step);
    } else {
      _activeRaf = null;
      _animating = false;
      onDone?.();
    }
  };

  _activeRaf = requestAnimationFrame(step);
}

/**
 * 返回节点位移动画控制器（须在 ReactFlowProvider 内使用，实测不依赖但保持上下文一致）。
 */
export function useTidyAnimation() {

  /** 取消进行中的动画，节点停在当前插值位置 */
  const cancel = useCallback(() => {
    cancelTidyAnimation();
  }, []);

  useEffect(() => cancel, [cancel]);

  // 模块级函数引用稳定，直接透传（重复调用自动取消上一次动画）
  return { animateTo: animateNodesTo, cancel };
}

/** applyTidyLayout 所需的 React Flow 实例能力子集 */
export interface TidyRfLike {
  fitView: (opts?: { duration?: number }) => unknown;
}

export interface ApplyTidyLayoutOptions {
  /** 跳过整理前压栈（agent 回合会把整理并入整批变更的一次撤销） */
  skipHistory?: boolean;
  /** 动画逐帧写入不进用户操作历史（agent 触发的整理为 true） */
  suppressTracking?: boolean;
}

/**
 * 整理画布编排（单一实现）：计算布局 → 压栈 → 落位/动画 → 视口自适应。
 * 此前工具栏入口（InfiniteCanvas.handleTidyCanvas）与 Agent 桥（Runtime.tidyCanvas）
 * 各持一份逐行相同的编排，动画分支靠人肉保持一致。
 *
 * 返回是否实际移动了节点；skipHistory 时不自压快照，由调用方把整理并入整批变更的撤销。
 */
export function applyTidyLayout(rf: TidyRfLike, opts: ApplyTidyLayoutOptions = {}): boolean {
  const store = useCanvasStore.getState();
  if (store.nodes.length < 2) return false;

  const result = computeTidyLayout(store.nodes, store.edges, {
    mode: "auto",
    snapSize: store.snapToGrid ? store.snapGridSize : 0,
  });
  if (result.movedCount === 0) return false;

  // setNodes/animateTo 不自动压栈；未跳过时整理前显式压一次，保证整块布局可一步撤销
  if (!opts.skipHistory) {
    useHistoryStore.getState().push(takeCanvasSnapshot());
  }

  // 节点过多时直接落位，避免每帧 setNodes 掉帧
  if (result.movedCount > TIDY_MAX_ANIMATED_NODES) {
    store.setNodes(
      store.nodes.map((n) => {
        const p = result.positions.get(n.id);
        return p ? { ...n, position: p } : n;
      }),
    );
    markDirtyImmediate();
    void rf.fitView({ duration: 300 });
    return true;
  }

  animateNodesTo(result.positions, {
    duration: TIDY_ANIMATION_DURATION,
    suppressTracking: !!opts.suppressTracking,
    onDone: () => {
      markDirtyImmediate();
      void rf.fitView({ duration: 300 });
    },
  });
  return true;
}
