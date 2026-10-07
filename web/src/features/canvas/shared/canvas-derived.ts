/**
 * Canvas projections shared by high-frequency consumers.
 *
 * React Flow position updates replace the nodes array on every drag frame. The
 * projection is therefore cached by the immutable nodes/edges references so
 * all rail subscribers and canvas consumers share one linear derivation.
 */
import type { Edge } from "@xyflow/react";

import { NODE_TYPE_ORDER } from "@/features/canvas/NodeTypeDisplayMeta";
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, NODE_TYPE, RAIL_WIDTH } from "@/lib/constants";

import { buildNodeIndex, nodeAbsolutePosition } from "./group-bounds";
import { measureNode } from "./tidy-layout";

export interface SelectionFrame {
  ids: string[];
  bbox: { x: number; y: number; width: number; height: number };
}

export interface OutlineGroup {
  type: string;
  nodes: AnyNode[];
}

export interface CanvasOutline {
  groupNodes: AnyNode[];
  membersByGroup: Map<string, AnyNode[]>;
  ungroupedGroups: OutlineGroup[];
  nodeCount: number;
}

export interface CanvasDerived {
  selectionFrame: SelectionFrame | null;
  selectedNodeIds: ReadonlySet<string>;
  highlightedEdgeIds: ReadonlySet<string>;
  railWidths: ReadonlyMap<string, number>;
  outline: CanvasOutline;
}

const derivedCache = new WeakMap<AnyNode[], WeakMap<Edge[], CanvasDerived>>();
const selectedSetCache = new Map<string, ReadonlySet<string>>();
const outlineCache = new Map<string, CanvasOutline>();
const edgeSetCache = new WeakMap<Edge[], Map<string, ReadonlySet<string>>>();
const objectIdentity = new WeakMap<object, number>();
let nextObjectIdentity = 1;

function identityOf(value: object): number {
  const existing = objectIdentity.get(value);
  if (existing !== undefined) return existing;
  const identity = nextObjectIdentity++;
  objectIdentity.set(value, identity);
  return identity;
}

function cacheValue<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function railKey(nodeId: string, side: "left" | "right"): string {
  return `${nodeId}:${side}`;
}

function stableSelectedIds(nodes: AnyNode[]): ReadonlySet<string> {
  const ids = nodes.filter((node) => node.selected).map((node) => node.id).sort();
  const key = JSON.stringify(ids);
  const cached = selectedSetCache.get(key);
  if (cached) return cached;
  return cacheValue(selectedSetCache, key, new Set(ids), 128);
}

function outlineKey(nodes: AnyNode[]): string {
  return nodes.map((node) => [
    node.id,
    node.type ?? "",
    node.parentId ?? "",
    typeof node.data === "object" && node.data !== null ? identityOf(node.data) : 0,
  ].join("\u0000")).join("\u0001");
}

function groupNodesByType(nodes: AnyNode[]): OutlineGroup[] {
  const byType = new Map<string, AnyNode[]>();
  for (const node of nodes) {
    const list = byType.get(node.type || "");
    if (list) list.push(node);
    else byType.set(node.type || "", [node]);
  }

  const groups: OutlineGroup[] = [];
  for (const type of NODE_TYPE_ORDER) {
    const list = byType.get(type);
    if (list?.length) groups.push({ type, nodes: list.reverse() });
    byType.delete(type);
  }
  for (const [type, list] of byType) {
    if (list.length) groups.push({ type, nodes: list.reverse() });
  }
  return groups;
}

function buildOutline(nodes: AnyNode[]): CanvasOutline {
  const groupNodes: AnyNode[] = [];
  const groupIds = new Set<string>();
  const membersByGroup = new Map<string, AnyNode[]>();
  const ungrouped: AnyNode[] = [];

  for (const node of nodes) {
    if (node.type === NODE_TYPE.GROUP) {
      groupNodes.push(node);
      groupIds.add(node.id);
    }
  }
  for (const node of nodes) {
    if (node.type === NODE_TYPE.GROUP) continue;
    if (node.parentId && groupIds.has(node.parentId)) {
      const members = membersByGroup.get(node.parentId);
      if (members) members.push(node);
      else membersByGroup.set(node.parentId, [node]);
    } else {
      ungrouped.push(node);
    }
  }

  const order = new Map(NODE_TYPE_ORDER.map((type, index) => [type, index]));
  for (const members of membersByGroup.values()) {
    members.sort((a, b) => (order.get(a.type || "") ?? NODE_TYPE_ORDER.length) - (order.get(b.type || "") ?? NODE_TYPE_ORDER.length));
  }

  return {
    groupNodes,
    membersByGroup,
    ungroupedGroups: groupNodesByType(ungrouped),
    nodeCount: nodes.length,
  };
}

function getStableOutline(nodes: AnyNode[]): CanvasOutline {
  const key = outlineKey(nodes);
  const cached = outlineCache.get(key);
  if (cached) return cached;
  return cacheValue(outlineCache, key, buildOutline(nodes), 128);
}

function computeSelectionFrame(
  nodes: AnyNode[],
  nodeById: Map<string, AnyNode>,
): SelectionFrame | null {
  const selected = nodes.filter((node) => node.selected && node.type !== NODE_TYPE.GROUP);
  if (selected.length < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of selected) {
    const absolute = nodeAbsolutePosition(node, nodeById);
    const size = measureNode(node);
    minX = Math.min(minX, absolute.x);
    minY = Math.min(minY, absolute.y);
    maxX = Math.max(maxX, absolute.x + size.width);
    maxY = Math.max(maxY, absolute.y + size.height);
  }
  return {
    ids: selected.map((node) => node.id),
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

function buildRailWidths(
  nodes: AnyNode[],
  nodeById: Map<string, AnyNode>,
  selectionFrame: SelectionFrame | null,
): ReadonlyMap<string, number> {
  const groupSizes = new Map<string, { width: number }>();
  for (const node of nodes) {
    if (node.type === NODE_TYPE.GROUP) groupSizes.set(node.id, { width: measureNode(node).width });
  }
  const frameIds = selectionFrame ? new Set(selectionFrame.ids) : null;
  const widths = new Map<string, number>();

  for (const node of nodes) {
    if (node.type === NODE_TYPE.GROUP) continue;
    const memberGroup = node.parentId ? nodeById.get(node.parentId) : undefined;
    const groupSize = memberGroup?.type === NODE_TYPE.GROUP ? groupSizes.get(memberGroup.id) : undefined;
    const nodeSize = measureNode(node);
    const memberLeft = groupSize
      ? node.position.x <= 0 ? RAIL_WIDTH : Math.min(RAIL_WIDTH, node.position.x)
      : RAIL_WIDTH;
    const memberRight = groupSize
      ? groupSize.width - (node.position.x + nodeSize.width) <= 0
        ? RAIL_WIDTH
        : Math.min(RAIL_WIDTH, groupSize.width - (node.position.x + nodeSize.width))
      : RAIL_WIDTH;

    let frameLeft = RAIL_WIDTH;
    let frameRight = RAIL_WIDTH;
    if (selectionFrame && frameIds!.has(node.id)) {
      const absolute = nodeAbsolutePosition(node, nodeById);
      const leftClearance = absolute.x - (selectionFrame.bbox.x - GROUP_NODE_PADDING);
      const rightClearance = selectionFrame.bbox.x + selectionFrame.bbox.width + GROUP_NODE_PADDING - (absolute.x + nodeSize.width);
      frameLeft = leftClearance <= 0 ? RAIL_WIDTH : Math.min(RAIL_WIDTH, leftClearance);
      frameRight = Math.min(
        RAIL_WIDTH,
        rightClearance <= 0 ? RAIL_WIDTH : rightClearance,
      );
    }
    widths.set(railKey(node.id, "left"), Math.min(memberLeft, frameLeft));
    widths.set(railKey(node.id, "right"), Math.min(memberRight, frameRight));
  }
  return widths;
}

function stableHighlightedEdges(edges: Edge[], selectedNodeIds: ReadonlySet<string>): ReadonlySet<string> {
  const key = JSON.stringify([...selectedNodeIds]);
  let bySelection = edgeSetCache.get(edges);
  if (!bySelection) {
    bySelection = new Map();
    edgeSetCache.set(edges, bySelection);
  }
  const cached = bySelection.get(key);
  if (cached) return cached;
  const highlighted = new Set(
    edges
      .filter((edge) => selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target))
      .map((edge) => edge.id),
  );
  return cacheValue(bySelection, key, highlighted, 32);
}

function derive(nodes: AnyNode[], edges: Edge[]): CanvasDerived {
  const nodeById = buildNodeIndex(nodes);
  const selectedNodeIds = stableSelectedIds(nodes);
  const selectionFrame = computeSelectionFrame(nodes, nodeById);
  return {
    selectionFrame,
    selectedNodeIds,
    highlightedEdgeIds: stableHighlightedEdges(edges, selectedNodeIds),
    railWidths: buildRailWidths(nodes, nodeById, selectionFrame),
    outline: getStableOutline(nodes),
  };
}

/** Return one shared projection for all subscribers of the same immutable state. */
export function getCanvasDerived(nodes: AnyNode[], edges: Edge[]): CanvasDerived {
  let byEdges = derivedCache.get(nodes);
  if (!byEdges) {
    byEdges = new WeakMap<Edge[], CanvasDerived>();
    derivedCache.set(nodes, byEdges);
  }
  const cached = byEdges.get(edges);
  if (cached) return cached;
  const value = derive(nodes, edges);
  byEdges.set(edges, value);
  return value;
}

export function canvasRailKey(nodeId: string | null, side: "left" | "right"): string | null {
  return nodeId ? railKey(nodeId, side) : null;
}
