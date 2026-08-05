import type { Edge } from "@xyflow/react";

// ============================================================
// Canvas 基础类型（画布状态、节点类型枚举）
// ============================================================

export type AnyEdge = Edge<Record<string, unknown>, string>;

export type BackgroundType = "dots" | "grid" | "blank";
export type ThemeMode = "light" | "dark";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

// ============================================================
// 节点类型枚举
// ============================================================

export const NODE_TYPE = {
  TEXT: "text-node",
  IMAGE: "image-node",
  VIDEO: "video-node",
  AUDIO: "audio-node",
  DIRECTOR: "director-node",
  GROUP: "group-node",
} as const;
