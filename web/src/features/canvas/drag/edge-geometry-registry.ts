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
/** 节点 → 相关联的边：拖动会话据此只处理移动集关联的边 */
const edgesByNode = new Map<string, Set<string>>();

/** 从节点索引移除该边（重登记时端点可能变化，先按旧端点摘除） */
function detachFromNodeIndex(edgeId: string): void {
  const geometry = registry.get(edgeId);
  if (!geometry) return;
  for (const nodeId of new Set([geometry.sourceId, geometry.targetId])) {
    const edgeIds = edgesByNode.get(nodeId);
    if (!edgeIds) continue;
    edgeIds.delete(edgeId);
    if (edgeIds.size === 0) edgesByNode.delete(nodeId);
  }
}

export function registerEdgeGeometry(edgeId: string, geometry: RegisteredEdgeGeometry): void {
  detachFromNodeIndex(edgeId);
  registry.set(edgeId, geometry);
  for (const nodeId of new Set([geometry.sourceId, geometry.targetId])) {
    const edgeIds = edgesByNode.get(nodeId);
    if (edgeIds) edgeIds.add(edgeId);
    else edgesByNode.set(nodeId, new Set([edgeId]));
  }
}

export function unregisterEdgeGeometry(edgeId: string): void {
  detachFromNodeIndex(edgeId);
  registry.delete(edgeId);
}

export function getEdgeGeometry(edgeId: string): RegisteredEdgeGeometry | undefined {
  return registry.get(edgeId);
}

/** 与给定节点集合相关联的边 id（拖动预览只需要这些边的 DOM 与几何） */
export function edgeIdsForNodes(nodeIds: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const nodeId of nodeIds) {
    const edgeIds = edgesByNode.get(nodeId);
    if (!edgeIds) continue;
    for (const edgeId of edgeIds) result.add(edgeId);
  }
  return result;
}
