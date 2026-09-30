/**
 * 画布 Agent 运行时桥。
 * React Flow 实例只能在 ReactFlowProvider 内部拿到，而 Agent 抽屉挂载在
 * 同一棵树里但工具执行发生在 store 层——通过模块级 registry 把实例能力
 * （视口控制、聚焦节点、整理布局）暴露给执行器。
 */
"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";

import { applyTidyLayout } from "@/features/canvas/hooks/use-tidy-animation";
import { buildNodeIndex, nodeAbsolutePosition } from "@/features/canvas/shared/group-bounds";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

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

  useEffect(() => {
    runtime = {
      focusNode: (node) => {
        const w = (node.style?.width as number) ?? 200;
        const h = (node.style?.height as number) ?? 200;
        // 视口跳转语义是世界坐标：成员 position 是组内相对坐标，先换算
        const abs = nodeAbsolutePosition(node, buildNodeIndex(useCanvasStore.getState().nodes));
        rf.setCenter(abs.x + w / 2, abs.y + h / 2, { zoom: 1.0, duration: 300 });
      },
      focusNodes: (nodeIds) => {
        if (!nodeIds.length) return;
        // fitView 内部按节点绝对矩形取景，Sub Flow 成员天然正确
        void rf.fitView({ nodes: nodeIds.map((id) => ({ id })), duration: 300, padding: 0.3 });
      },
      tidyCanvas: (opts) =>
        // 编排单源在 applyTidyLayout（与工具栏入口共用）；
        // agent 触发的整理：跳过自压栈（并入整批变更的一次撤销）且动画帧不进用户操作历史
        applyTidyLayout(rf, {
          skipHistory: !!opts?.skipHistory,
          suppressTracking: !!opts?.skipHistory,
        }),
      setCenter: (x, y, zoom) => {
        rf.setCenter(x, y, { zoom: zoom ?? rf.getZoom(), duration: 300 });
      },
    };
    return () => {
      runtime = null;
    };
  }, [rf]);

  return null;
}
