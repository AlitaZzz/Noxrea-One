/**
 * Canvas store 的 React 适配层。
 *
 * 文档状态与纯写入位于 canvas-document-store（叶子模块）；本模块只把 vanilla
 * store 适配为既有 `useCanvasStore` 调用面（hook 选择器与 `getState` /
 * `setState` / `subscribe`），并保留需要保存器参与的 `flushAndWait`。
 * 组件继续从这里读取状态和动作，不直接依赖保存器。
 */
import { useStore } from "zustand";

import { saveManager } from "@/features/canvas/persistence/save-manager";
import {
  canvasDocumentStore,
  type CanvasState,
} from "@/features/canvas/stores/canvas-document-store";

export type {
  CanvasInteraction,
  CanvasState,
  HistoryPushOptions,
  InteractionAction,
  NodeUiStateSnapshot,
} from "@/features/canvas/stores/canvas-document-store";
export {
  findFreePosition,
  getCanvasProjectId,
  getLiveViewport,
  getViewportCenter,
  isNodeInUiState,
  markDirty,
  markDirtyImmediate,
  markDirtyUndo,
  MEDIA_EDITOR_NODE_ID_KEYS,
  NODE_UI_STATE_KEYS,
  pushHistoryThrottled,
  syncLiveViewport,
  takeCanvasSnapshot,
  withHistoryBatch,
} from "@/features/canvas/stores/canvas-document-store";

function useCanvasStoreImpl(): CanvasState;
function useCanvasStoreImpl<T>(selector: (state: CanvasState) => T): T;
function useCanvasStoreImpl<T>(selector?: (state: CanvasState) => T): T | CanvasState {
  return useStore(canvasDocumentStore, selector ?? ((state: CanvasState) => state as unknown as T));
}

/**
 * 既有调用面：既可作为 hook 传入选择器，也可经 `getState` / `setState` /
 * `subscribe` 命令式访问。状态真相源是 `canvasDocumentStore`，不存在第二份。
 */
export const useCanvasStore = Object.assign(useCanvasStoreImpl, {
  getState: canvasDocumentStore.getState,
  getInitialState: canvasDocumentStore.getInitialState,
  setState: canvasDocumentStore.setState,
  subscribe: canvasDocumentStore.subscribe,
});

/** 等待保存完成并确保最终状态已落盘（项目切换等场景） */
export function flushAndWait(): Promise<void> {
  return saveManager.flushAndWait();
}
