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

import { useCallback, useEffect, useRef } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/** 是否正在播放整理动画（供画布交互判断是否需要让路） */
let _animating = false;

/** 读取动画进行中标志 */
export function isTidyAnimating(): boolean {
  return _animating;
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
}

/**
 * 返回节点位移动画控制器（须在 ReactFlowProvider 内使用，实测不依赖但保持上下文一致）。
 */
export function useTidyAnimation() {
  const rafRef = useRef<number | null>(null);

  /** 取消进行中的动画，节点停在当前插值位置 */
  const cancel = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    _animating = false;
  }, []);

  useEffect(() => cancel, [cancel]);

  /**
   * 把节点插值移动到 targets（nodeId → 目标坐标）。
   * 重复调用会自动取消上一次动画。
   */
  const animateTo = useCallback(
    (targets: Map<string, { x: number; y: number }>, options: AnimateNodesOptions = {}) => {
      cancel();

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

        useCanvasStore.getState().setNodes(next);

        if (raw < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          _animating = false;
          onDone?.();
        }
      };

      rafRef.current = requestAnimationFrame(step);
    },
    [cancel],
  );

  return { animateTo, cancel };
}
