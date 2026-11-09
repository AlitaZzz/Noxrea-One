/**
 * SSE 握手下发项目快照的解析。
 *
 * 画布文档归 canvas：解析与默认值都在这里，`entities/project` 只接收
 * 投影后的 `ProjectSummary`（投影实现归 entity），不接触 `nodes` / `edges` / `viewport`。
 * 载荷不合法返回 null，调用方按协议错误收敛且不写任何状态。
 */
import { firstImageSrc } from "@noxrea/shared/canvas-summary";
import { isRecord } from "@noxrea/shared/object";
import { toTimestamp } from "@noxrea/shared/time";

import { DEFAULT_SNAP_ENABLED, DEFAULT_VIEWPORT } from "@/lib/constants";
import type { ViewportState } from "@/lib/types/canvas";

import type { AnyEdge, AnyNode, CanvasProject } from "../types";

/**
 * 握手是画布内容的信任边界：服务端 canvasData 是未验证 JSON，
 * 这里的校验必须覆盖下游 `restoreFromProject` 与 React Flow 的硬前置
 * （节点/边的对象形态、唯一 id、视口数值），否则非法快照会在写摘要之后
 * 才抛错，页面停在重连态且无法自愈。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 节点最小结构契约：id/type/position/data 是 store 与 React Flow 的硬前置 */
function isCanvasNode(value: unknown): value is AnyNode {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.type)) return false;
  if (!isRecord(value.data) || !isRecord(value.position)) return false;
  if (!isFiniteNumber(value.position.x) || !isFiniteNumber(value.position.y)) return false;
  return value.parentId === undefined || typeof value.parentId === "string";
}

/** 边最小结构契约：React Flow 以 id 关联，source/target 决定渲染端点 */
function isCanvasEdge(value: unknown): value is AnyEdge {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.source) && isNonEmptyString(value.target);
}

/** 数组缺省视为空集合；成员不合法或节点 id 重复返回 null（不在此处预留 id） */
function parseNodes(value: unknown): AnyNode[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const nodes: AnyNode[] = [];
  for (const item of value) {
    if (!isCanvasNode(item) || ids.has(item.id)) return null;
    ids.add(item.id);
    nodes.push(item);
  }
  return nodes;
}

function parseEdges(value: unknown): AnyEdge[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const edges: AnyEdge[] = [];
  for (const item of value) {
    if (!isCanvasEdge(item) || ids.has(item.id)) return null;
    ids.add(item.id);
    edges.push(item);
  }
  return edges;
}

/**
 * 校验并映射握手项目快照。非法载荷返回 null（调用方按协议错误处理）。
 * `revision` 缺省折算为 1；类型或取值错误视为非法，避免把脏值写进 revision 账本。
 */
export function parseCanvasProject(payload: unknown): CanvasProject | null {
  if (!isRecord(payload)) return null;
  if (!isNonEmptyString(payload.id) || typeof payload.name !== "string") return null;
  if (typeof payload.updatedAt !== "string") return null;

  let revision = 1;
  if (payload.revision !== undefined) {
    const value = payload.revision;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
    revision = value;
  }
  const coverKey = payload.coverKey;
  if (coverKey !== undefined && coverKey !== null && typeof coverKey !== "string") return null;
  const canvasData = payload.canvasData;
  if (canvasData !== undefined && !isRecord(canvasData)) return null;
  const data = canvasData ?? {};

  const nodes = parseNodes(data.nodes);
  const edges = parseEdges(data.edges);
  if (nodes === null || edges === null) return null;

  let viewport: ViewportState = DEFAULT_VIEWPORT;
  if (data.viewport !== undefined) {
    const raw = data.viewport;
    if (!isRecord(raw)) return null;
    const { x, y, zoom } = raw;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom) || zoom <= 0) return null;
    viewport = { x, y, zoom };
  }

  let minimapVisible = true;
  if (data.minimapVisible !== undefined) {
    if (typeof data.minimapVisible !== "boolean") return null;
    minimapVisible = data.minimapVisible;
  }
  let snapEnabled = DEFAULT_SNAP_ENABLED;
  if (data.snapEnabled !== undefined) {
    if (typeof data.snapEnabled !== "boolean") return null;
    snapEnabled = data.snapEnabled;
  }
  // 增量保存允许用 null 清除 agentModel（见服务端 applyCanvasDelta）
  let agentModel: string | undefined;
  if (data.agentModel !== undefined && data.agentModel !== null) {
    if (typeof data.agentModel !== "string") return null;
    agentModel = data.agentModel;
  }

  return {
    id: payload.id,
    name: payload.name,
    revision,
    updatedAt: toTimestamp(payload.updatedAt, Date.now()),
    thumbnail: coverKey ?? firstImageSrc(nodes),
    coverKey: coverKey ?? undefined,
    nodeCount: nodes.length,
    viewport,
    minimapVisible,
    snapEnabled,
    agentModel,
    nodes,
    edges,
  };
}
