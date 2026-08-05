/**
 * 全局状态仓库桶文件（barrel）。
 * 统一导出画布、历史、选择、项目、鉴权、模型、资产、语言、右键菜单等 store
 * 及保存管理器。
 */
export { useCanvasStore, takeCanvasSnapshot, getViewportCenter, findFreePosition, markDirty, markDirtyImmediate, syncLiveViewport, getLiveViewport, flushAndWait, flushOnUnload } from "./canvas-store";
export { useHistoryStore } from "./history-store";
export { useSelectionStore } from "./selection-store";
export { useProjectStore } from "./project-store";
export { useAuthStore } from "./auth-store";
export type { UserInfo } from "./auth-store";
export { useModelStore } from "./model-store";
export { useAssetsStore, ASSET_PAGE_SIZE, computeRecursiveFolderCounts } from "./assets-store";
export type { AssetListState } from "./assets-store";
export { useI18nStore } from "./i18n-store";
export { useCtxMenu } from "./context-menu-store";
export { saveManager } from "./save-manager";
