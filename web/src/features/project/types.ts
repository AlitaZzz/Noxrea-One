/**
 * 项目与历史相关类型定义。
 * 包含画布项目结构 CanvasProject、历史快照与剪贴板数据类型。
 */
import type { AnyEdge, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";

// ============================================================
// 项目
// ============================================================

/**
 * 项目摘要：列表页与 revision 账本的最小单元。
 * 列表接口只返回这些字段，不含任何画布内容。
 */
export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  /** 列表卡片缩略图：自定义封面优先，否则首个图片节点 src（服务端投影） */
  thumbnail?: string;
  /** 用户自定义封面 URL（未设置为 undefined） */
  coverUrl?: string;
  /** 节点总数（服务端投影） */
  nodeCount: number;
}

/**
 * 单项目全量投影：摘要字段 + 画布内容。
 * 唯一来源是 SSE 握手首帧下发的服务端快照（use-canvas-session 采纳）；
 * 项目列表（projects 数组）不持有内容。
 */
export interface CanvasProject extends ProjectSummary {
  viewport: ViewportState;
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
  minimapVisible: boolean;
  snapToGrid: boolean;
  agentModel?: string;
}

export interface CanvasDataDelta {
  nodes: { upsert: AnyNode[]; delete: string[] };
  edges: { upsert: AnyEdge[]; delete: string[] };
  viewport?: ViewportState;
  minimapVisible?: boolean;
  snapToGrid?: boolean;
  agentModel?: string | null;
}

// ============================================================
// 历史记录（undo/redo）
// ============================================================

export interface HistorySnapshot {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
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
