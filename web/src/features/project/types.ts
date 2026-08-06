/**
 * 项目与历史相关类型定义。
 * 包含画布项目结构 CanvasProject、历史快照与剪贴板数据类型。
 */
import type { AnyEdge, BackgroundType, ThemeMode, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";

// ============================================================
// 项目
// ============================================================

export interface CanvasProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  viewport: ViewportState;
  background: BackgroundType;
  theme: ThemeMode;
  minimapVisible?: boolean;
  snapToGrid?: boolean;
  agentModel?: string;
  nodes: AnyNode[];
  edges: AnyEdge[];
}

// ============================================================
// 历史记录（undo/redo）
// ============================================================

export interface HistorySnapshot {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  background: BackgroundType;
  theme: ThemeMode;
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
