import type { AnyEdge } from "./canvas";
import type { AnyNode } from "./nodes";
import type { BackgroundType, ThemeMode, ViewportState } from "./canvas";

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
