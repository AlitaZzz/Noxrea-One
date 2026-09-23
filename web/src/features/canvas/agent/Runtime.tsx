/**
 * 画布 Agent 运行时桥。
 * React Flow 实例只能在 ReactFlowProvider 内部拿到，而 Agent 抽屉挂载在
 * 同一棵树里但工具执行发生在 store 层——通过模块级 registry 把实例能力
 * （视口控制、聚焦节点、整理布局）暴露给执行器。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";

import { useTidyAnimation } from "@/features/canvas/hooks/use-tidy-animation";
import { computeTidyLayout } from "@/features/canvas/shared/tidy-layout";
import {
  markDirtyImmediate,
  takeCanvasSnapshot,
  useCanvasStore,
} from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";
import { TIDY_ANIMATION_DURATION, TIDY_MAX_ANIMATED_NODES } from "@/lib/constants";

export interface CanvasAgentRuntime {
  /** 聚焦某个节点（视口居中，带动画） */
  focusNode: (node: AnyNode) => void;
  /** 聚焦多个节点（自适应缩放） */
  focusNodes: (nodeIds: string[]) => void;
  /**
   * 整理画布布局（含动画与视口自适应）。
   * 返回是否实际移动了节点；skipHistory 时不自压快照，
   * 由调用方（如 agent 回合）把整理并入整批变更的一次撤销。
   */
  tidyCanvas: (opts?: { skipHistory?: boolean }) => boolean;
  /** 世界坐标跳转视口 */
  setCenter: (x: number, y: number, zoom?: number) => void;
}

let runtime: CanvasAgentRuntime | null = null;

export function setCanvasAgentRuntime(r: CanvasAgentRuntime | null): void {
  runtime = r;
}

export function getCanvasAgentRuntime(): CanvasAgentRuntime | null {
  return runtime;
}

/** 挂在 ReactFlowProvider 树内的桥组件：注册实例能力，卸载时注销 */
export default function CanvasAgentRuntimeBridge() {
  const rf = useReactFlow();
  const { animateTo } = useTidyAnimation();

  useEffect(() => {
    runtime = {
      focusNode: (node) => {
        const w = (node.style?.width as number) ?? 200;
        const h = (node.style?.height as number) ?? 200;
        rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1.0, duration: 300 });
      },
      focusNodes: (nodeIds) => {
        if (!nodeIds.length) return;
        void rf.fitView({ nodes: nodeIds.map((id) => ({ id })), duration: 300, padding: 0.3 });
      },
      tidyCanvas: (opts) => {
        const store = useCanvasStore.getState();
        if (store.nodes.length < 2) return false;
        const result = computeTidyLayout(store.nodes, store.edges, {
          mode: "auto",
          snapSize: store.snapToGrid ? store.snapGridSize : 0,
        });
        if (result.movedCount === 0) return false;

        // setNodes/animateTo 不自动压栈；未跳过时整理前显式压一次，保证整块布局可一步撤销
        if (!opts?.skipHistory) {
          useHistoryStore.getState().push(takeCanvasSnapshot());
        }

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

        animateTo(result.positions, {
          duration: TIDY_ANIMATION_DURATION,
          onDone: () => {
            markDirtyImmediate();
            void rf.fitView({ duration: 300 });
          },
        });
        return true;
      },
      setCenter: (x, y, zoom) => {
        rf.setCenter(x, y, { zoom: zoom ?? rf.getZoom(), duration: 300 });
      },
    };
    return () => {
      runtime = null;
    };
  }, [rf, animateTo]);

  return null;
}
