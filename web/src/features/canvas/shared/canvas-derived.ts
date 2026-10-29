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
import { isGroupNode, memberParentId } from "./group-membership";
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
  membersByGroup: ReadonlyMap<string, AnyNode[]>;
  ungroupedGroups: OutlineGroup[];
  nodeCount: number;
}

/** 组成员归属投影：组节点、按组归集的成员（类型顺序）、非组成员。 */
export interface GroupMembership {
  groupNodes: AnyNode[];
  membersByGroup: ReadonlyMap<string, AnyNode[]>;
  ungrouped: AnyNode[];
}

export interface CanvasDerived {
  selectionFrame: SelectionFrame | null;
  selectedNodeIds: ReadonlySet<string>;
  highlightedEdgeIds: ReadonlySet<string>;
  railWidths: ReadonlyMap<string, number>;
}

/** 上游文本引用（生成面板）：内容已 trim，空内容不进入结果。 */
export interface UpstreamTextRef {
  id: string;
  content: string;
}

/** 上游媒体引用（生成面板）：src / label 已 trim，空 src 不进入结果。 */
export interface UpstreamMediaRef {
  id: string;
  src: string;
  label: string;
}

export interface NodeUpstreamRefs {
  /** 上游图片 src，按节点数组顺序（与生成面板既有顺序一致）。 */
  images: string[];
  /** 上游文本，按连线顺序，按节点 id 去重。 */
  texts: UpstreamTextRef[];
  /** 上游音频，按连线顺序，按节点 id 与 src 双重去重。 */
  audios: UpstreamMediaRef[];
  /** 上游视频，按连线顺序，按节点 id 与 src 双重去重。 */
  videos: UpstreamMediaRef[];
}

const derivedCache = new WeakMap<AnyNode[], WeakMap<Edge[], CanvasDerived>>();
const selectedSetCache = new Map<string, ReadonlySet<string>>();
const outlineCache = new Map<string, CanvasOutline>();
const membershipCache = new WeakMap<AnyNode[], GroupMembership>();
const upstreamCache = new Map<string, NodeUpstreamRefs>();
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

function nodeDataIdentity(node: AnyNode): number {
  return typeof node.data === "object" && node.data !== null ? identityOf(node.data) : 0;
}

function outlineKey(nodes: AnyNode[]): string {
  return nodes.map((node) => [
    node.id,
    node.type ?? "",
    node.parentId ?? "",
    nodeDataIdentity(node),
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

const NODE_TYPE_ORDER_INDEX = new Map(NODE_TYPE_ORDER.map((type, index) => [type, index] as const));

function buildGroupMembership(nodes: AnyNode[]): GroupMembership {
  const groupNodes: AnyNode[] = [];
  const groupIds = new Set<string>();
  const membersByGroup = new Map<string, AnyNode[]>();
  const ungrouped: AnyNode[] = [];

  for (const node of nodes) {
    if (!isGroupNode(node)) continue;
    groupNodes.push(node);
    groupIds.add(node.id);
  }
  for (const node of nodes) {
    if (isGroupNode(node)) continue;
    const parentId = memberParentId(node);
    if (parentId && groupIds.has(parentId)) {
      const members = membersByGroup.get(parentId);
      if (members) members.push(node);
      else membersByGroup.set(parentId, [node]);
    } else {
      ungrouped.push(node);
    }
  }

  for (const members of membersByGroup.values()) {
    members.sort((a, b) =>
      (NODE_TYPE_ORDER_INDEX.get(a.type || "") ?? NODE_TYPE_ORDER.length) -
      (NODE_TYPE_ORDER_INDEX.get(b.type || "") ?? NODE_TYPE_ORDER.length));
  }

  return { groupNodes, membersByGroup, ungrouped };
}

/**
 * 组成员归属（按 nodes 引用缓存）。
 * 组框尺寸与元素树都消费同一份归属；按引用缓存避免位置帧重复扫描全表。
 */
export function getGroupMembership(nodes: AnyNode[]): GroupMembership {
  const cached = membershipCache.get(nodes);
  if (cached) return cached;
  const value = buildGroupMembership(nodes);
  membershipCache.set(nodes, value);
  return value;
}

function buildOutline(nodes: AnyNode[]): CanvasOutline {
  const { groupNodes, membersByGroup, ungrouped } = getGroupMembership(nodes);
  return {
    groupNodes,
    membersByGroup,
    ungroupedGroups: groupNodesByType(ungrouped),
    nodeCount: nodes.length,
  };
}

/**
 * 元素树专用的画布大纲。包含全量字符串键与分组排序，只在资源浏览器订阅时
 * 计算；位置帧的共享投影（getCanvasDerived）不再承担这部分成本。
 */
export function getCanvasOutline(nodes: AnyNode[]): CanvasOutline {
  const key = outlineKey(nodes);
  const cached = outlineCache.get(key);
  if (cached) return cached;
  return cacheValue(outlineCache, key, buildOutline(nodes), 128);
}

function computeSelectionFrame(
  nodes: AnyNode[],
  nodeById: Map<string, AnyNode>,
): SelectionFrame | null {
  const selected = nodes.filter((node) => node.selected && !isGroupNode(node));
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
    if (isGroupNode(node)) groupSizes.set(node.id, { width: measureNode(node).width });
  }
  const frameIds = selectionFrame ? new Set(selectionFrame.ids) : null;
  const widths = new Map<string, number>();

  for (const node of nodes) {
    if (isGroupNode(node)) continue;
    const parentId = memberParentId(node);
    const groupSize = parentId ? groupSizes.get(parentId) : undefined;
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

// ============================================================
// 上游引用（生成面板）
// ============================================================

/**
 * 结构键：只包含决定上游引用结果的输入——入边序列与上游节点的身份/数据。
 * 拖动只替换位置（node.data 引用不变），因此位置帧命中同一键并复用同一份引用，
 * 面板订阅不会随每帧重渲染。
 */
function upstreamKey(nodes: AnyNode[], edges: Edge[], nodeId: string): string {
  const upstreamIds = new Set<string>();
  let key = nodeId;
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    upstreamIds.add(edge.source);
    key += `\u0001${edge.id}\u0000${edge.source}`;
  }
  for (const node of nodes) {
    if (!upstreamIds.has(node.id)) continue;
    key += `\u0001${node.id}\u0000${node.type ?? ""}\u0000${nodeDataIdentity(node)}`;
  }
  return key;
}

/** 媒体引用统一规则：src / label trim，空 src 丢弃，按节点 id 与 src 双重去重。 */
function pushMediaRef(
  refs: UpstreamMediaRef[],
  seenIds: Set<string>,
  seenSrcs: Set<string>,
  node: AnyNode,
): void {
  const src = ((node.data as { src?: string }).src || "").trim();
  const label = ((node.data as { label?: string }).label || "").trim();
  if (src === "" || seenIds.has(node.id) || seenSrcs.has(src)) return;
  seenIds.add(node.id);
  seenSrcs.add(src);
  refs.push({ id: node.id, src, label });
}

function buildUpstreamRefs(nodes: AnyNode[], edges: Edge[], nodeId: string): NodeUpstreamRefs {
  const incoming: Edge[] = [];
  const upstreamIds = new Set<string>();
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    incoming.push(edge);
    upstreamIds.add(edge.source);
  }

  // 图片按节点数组顺序（生成面板既有顺序），其余按连线顺序
  const byId = new Map<string, AnyNode>();
  const images: string[] = [];
  for (const node of nodes) {
    if (!upstreamIds.has(node.id)) continue;
    byId.set(node.id, node);
    if (node.type !== NODE_TYPE.IMAGE) continue;
    const src = (node.data as { src?: string }).src;
    if (src) images.push(src);
  }

  const texts: UpstreamTextRef[] = [];
  const audios: UpstreamMediaRef[] = [];
  const videos: UpstreamMediaRef[] = [];
  const seenTextIds = new Set<string>();
  const seenAudioIds = new Set<string>();
  const seenAudioSrcs = new Set<string>();
  const seenVideoIds = new Set<string>();
  const seenVideoSrcs = new Set<string>();

  for (const edge of incoming) {
    const node = byId.get(edge.source);
    if (!node) continue;
    if (node.type === NODE_TYPE.TEXT) {
      const content = ((node.data as { plainText?: string }).plainText || "").trim();
      if (content === "" || seenTextIds.has(node.id)) continue;
      seenTextIds.add(node.id);
      texts.push({ id: node.id, content });
    } else if (node.type === NODE_TYPE.AUDIO) {
      pushMediaRef(audios, seenAudioIds, seenAudioSrcs, node);
    } else if (node.type === NODE_TYPE.VIDEO) {
      pushMediaRef(videos, seenVideoIds, seenVideoSrcs, node);
    }
  }

  return { images, texts, audios, videos };
}

/** 生成面板共用的上游引用投影：同一结构键返回同一引用。 */
export function getNodeUpstreamRefs(
  nodes: AnyNode[],
  edges: Edge[],
  nodeId: string,
): NodeUpstreamRefs {
  const key = upstreamKey(nodes, edges, nodeId);
  const cached = upstreamCache.get(key);
  if (cached) return cached;
  return cacheValue(upstreamCache, key, buildUpstreamRefs(nodes, edges, nodeId), 128);
}

export function canvasRailKey(nodeId: string | null, side: "left" | "right"): string | null {
  return nodeId ? railKey(nodeId, side) : null;
}
