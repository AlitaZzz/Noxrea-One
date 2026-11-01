/**
 * 画布流光注册表。
 *
 * 强调中的连线在这里登记几何，画布流光层按注册表逐帧绘制（specs/canvas-flow-layer.md
 * 规则 7）。登记与注销由 `DeletableEdge` 的强调态驱动；拖动预览会话以「预览覆盖」
 * 发布拖动期几何，结束/取消时清除覆盖，绘制回落到登记几何——拖动期不触发 React
 * 渲染，流光仍能跟随预览路径。
 *
 * 起手帧的预览可能先于强调登记到达：拖动在 `onNodeDragStart` 发布首帧，而选中态
 * 要等 React 提交后才让 `DeletableEdge` 登记几何。未登记的预览按原始几何/位移
 * 暂存，登记时立即生效，否则静止拖动会一直绘制拖动前的路径。
 *
 * 模块级单例：本仓库只挂载一个画布（规则「单画布假设」）。
 */
import type { BezierCurve } from "@/features/canvas/shared/edge-geometry";

import { buildFlowPattern, type FlowPattern } from "./flow-taper";

export interface FlowGeometry {
  curve: BezierCurve;
  /** 路径弧长：流光按长度归一化，与 SVG 的 pathLength=100 等效 */
  length: number;
  /** 整体平移（拖动预览的刚性平移分支）：绘制时平移控制点，不重算路径 */
  offset?: { x: number; y: number };
}

export interface FlowDrawable {
  geometry: FlowGeometry;
  pattern: FlowPattern;
}

/** 强调中的边（`DeletableEdge` 登记） */
const registered = new Map<string, FlowDrawable>();
/** 拖动预览覆盖（拖动会话发布，优先于登记几何） */
const previews = new Map<string, FlowDrawable>();
/** 尚未登记的预览：按原始形态缓存，登记时再结合登记分层物化 */
const pending = new Map<string, PendingPreview>();
const listeners = new Set<() => void>();

type PendingPreview =
  | { geometry: FlowGeometry }
  | { offset: { x: number; y: number } };

function drawable(geometry: FlowGeometry, pattern?: FlowPattern): FlowDrawable {
  return { geometry, pattern: pattern ?? buildFlowPattern(geometry.length) };
}

function materializePreview(base: FlowDrawable, preview: PendingPreview): FlowDrawable {
  if ("offset" in preview) {
    // 刚性平移：沿用登记几何与分层，只叠加位移
    return { geometry: { ...base.geometry, offset: preview.offset }, pattern: base.pattern };
  }
  // 路径重算：长度不变时沿用登记分层（拖动逐帧发布，避免重复构建）
  const { geometry } = preview;
  return drawable(geometry, base.geometry.length === geometry.length ? base.pattern : undefined);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 登记（或更新）一条强调边的几何；集合从空变为非空时通知渲染循环启动 */
export function setFlowEdge(id: string, geometry: FlowGeometry): void {
  const existing = registered.get(id);
  const base = drawable(geometry);
  registered.set(id, base);
  // 先到的预览在登记瞬间生效，不丢起手帧
  const buffered = pending.get(id);
  if (buffered) {
    pending.delete(id);
    previews.set(id, materializePreview(base, buffered));
  }
  if (!existing) notify();
}

/** 注销一条边（强调结束或组件卸载）；集合清空时通知渲染循环停止 */
export function removeFlowEdge(id: string): void {
  const removed = registered.delete(id);
  previews.delete(id);
  pending.delete(id);
  if (removed) notify();
}

/** 拖动预览几何覆盖（端点重算分支）；未登记时暂存，登记时生效 */
export function setFlowPreview(id: string, geometry: FlowGeometry): void {
  const base = registered.get(id);
  if (!base) {
    pending.set(id, { geometry });
    return;
  }
  previews.set(id, materializePreview(base, { geometry }));
}

/** 整段平移覆盖（刚性平移分支）：只发布位移，绘制按登记几何平移控制点 */
export function setFlowPreviewOffset(id: string, offset: { x: number; y: number }): void {
  const base = registered.get(id);
  if (!base) {
    pending.set(id, { offset });
    return;
  }
  previews.set(id, materializePreview(base, { offset }));
}

export function clearFlowPreview(id: string): void {
  previews.delete(id);
  pending.delete(id);
}

export function clearFlowPreviews(): void {
  previews.clear();
  pending.clear();
}

/** 实际绘制内容：预览覆盖优先 */
export function getFlowDrawable(id: string): FlowDrawable | undefined {
  return previews.get(id) ?? registered.get(id);
}

/** 登记中的边 id（绘制遍历顺序：登记顺序） */
export function flowEdgeIds(): IterableIterator<string> {
  return registered.keys();
}

export function hasFlowEdges(): boolean {
  return registered.size > 0;
}

export function subscribeFlowEdges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
