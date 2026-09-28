/**
 * 批量连线 Context。
 * 向渲染在节点 DOM 内、无法经 props 透传回调的节点组件（组节点的批量输出轨道
 * GroupConnectRail）传递接驳回调与视口换算。回调不能塞进持久化的 node data
 * ——会被写进快照与撤销历史，破坏序列化，所以走 Context（参照 EdgeHighlightContext）。
 */
"use client";

import { createContext, useContext } from "react";

export interface BatchConnectHandlers {
  /** 拖到已有节点：全有或全无批量扇出建边 */
  onConnectToNode: (participantIds: string[], targetId: string) => void;
  /** 拖到空白：弹出「创建连接节点」菜单，创建后批量接驳 */
  onConnectToBlank: (
    participantIds: string[],
    canvasPosition: { x: number; y: number },
    screenPosition: { x: number; y: number }
  ) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
}

export const BatchConnectContext = createContext<BatchConnectHandlers | null>(null);

export function useBatchConnect(): BatchConnectHandlers {
  const ctx = useContext(BatchConnectContext);
  if (!ctx) throw new Error("useBatchConnect 必须在 BatchConnectContext.Provider 内使用");
  return ctx;
}
