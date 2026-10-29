/**
 * 边几何登记表。
 *
 * `DeletableEdge` 每次拿到端点几何时登记（拖动前基准），卸载时注销。拖动预览
 * 会话从这里读取端点几何重算路径——React Flow 的 nodeLookup 在拖动期不更新，
 * 边组件自身的坐标停留在拖动前，登记值就是预览的唯一几何来源
 * （specs/canvas-drag-preview-session.md 规则 4.3、4.5）。
 */
import type { EdgeEndpointGeometry } from "@/features/canvas/shared/edge-geometry";

export interface RegisteredEdgeGeometry extends EdgeEndpointGeometry {
  sourceId: string;
  targetId: string;
}

const registry = new Map<string, RegisteredEdgeGeometry>();

export function registerEdgeGeometry(edgeId: string, geometry: RegisteredEdgeGeometry): void {
  registry.set(edgeId, geometry);
}

export function unregisterEdgeGeometry(edgeId: string): void {
  registry.delete(edgeId);
}

export function getEdgeGeometry(edgeId: string): RegisteredEdgeGeometry | undefined {
  return registry.get(edgeId);
}
