/**
 * Project feature 公开 API barrel。
 */

// ── API ──
export { projectApi } from "./api";

// ── Store ──
export { useProjectStore } from "./store";

// ── 保存管理器 ──
export { saveManager } from "./save-manager";

// ── 类型 ──
export type {
  CanvasProject,
  ClipboardData,
  HistorySnapshot,
} from "./types";
