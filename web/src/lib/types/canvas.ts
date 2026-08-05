/**
 * 画布基础类型定义（纯类型）。
 * 包含连线别名、背景与主题枚举、视口结构。
 * 节点类型常量 NODE_TYPE 已迁移至 lib/constants.ts。
 */
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
