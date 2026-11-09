/**
 * `features/canvas` 公共入口：页面级契约。
 *
 * 只导出页面组合所需的组件、hook、函数与公开类型；不导出 store、
 * 内部组件或内部 hook。
 */
export { flushCanvasSave } from "./persistence/save-manager";
export { default as CanvasRoot } from "./root/CanvasRoot";
export type { CanvasPorts, CanvasRootProps, CanvasSlots } from "./root/contracts";
export type { DirectorBridge } from "./root/use-director-bridge";
export { useDirectorBridge } from "./root/use-director-bridge";
export { useSessionExpired } from "./session/session-expired-store";
export type { CanvasSessionStatus } from "./session/use-canvas-session";
export { useCanvasSession } from "./session/use-canvas-session";
export { preloadCanvasPromptTemplates } from "./shared/prompt-presets";
