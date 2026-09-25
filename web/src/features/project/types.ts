/**
 * 项目与历史相关类型定义。
 * 包含画布项目结构 CanvasProject、历史快照与剪贴板数据类型。
 */
import type { AnyEdge, BackgroundType, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";

// ============================================================
// 项目
// ============================================================

export interface CanvasProject {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  viewport: ViewportState;
  background: BackgroundType;
  minimapVisible?: boolean;
  snapToGrid?: boolean;
  agentModel?: string;
  nodes: AnyNode[];
  edges: AnyEdge[];
}

/**
 * 提交服务端的画布内容快照。
 * 与 CanvasProject 的区别：不含服务端拥有的元数据（id/name/revision/updatedAt），
 * 只包含画布自身状态。
 */
export interface CanvasData {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  background: BackgroundType;
  minimapVisible: boolean;
  snapToGrid: boolean;
  agentModel?: string;
}

// ============================================================
// 历史记录（undo/redo）
// ============================================================

export interface HistorySnapshot {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  background: BackgroundType;
  minimapVisible: boolean;
  snapToGrid: boolean;
}

// ============================================================
// 剪贴板
// ============================================================

export interface ClipboardData {
  nodes: AnyNode[];
  edges: AnyEdge[];
}
