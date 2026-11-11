/**
 * 画布剪贴板格式（纯编解码，不触碰浏览器剪贴板 API）。
 *
 * 系统剪贴板载荷是一份独立的、带版本号的规范文档：
 * `{ kind, version, nodes, edges }`。它与 store 的节点结构分离——只保留
 * 可迁移的内容字段，任何 React Flow 运行时字段、生成任务绑定、上传会话
 * 都不会进入载荷。浏览器传输（ClipboardItem / paste 事件 / read()）见
 * canvas-system-clipboard.ts。
 *
 * 页面内入口见 specs/canvas-clipboard.md。
 */
import { acceptsInput } from "@/features/canvas/shared/connection-rules";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { canConnect, NODE_TYPE } from "@/lib/constants";

/** 自定义 MIME 的裸类型（Blob.type / clipboard.read() 中的类型） */
export const CANVAS_CLIPBOARD_MIME = "application/vnd.noxrea.canvas-selection+json";
/** Chromium Web Custom Format 的 ClipboardItem key（`web ` 是协议前缀，不是品牌前缀） */
export const CANVAS_CLIPBOARD_WEB_MIME = `web ${CANVAS_CLIPBOARD_MIME}`;
/** 载荷判别字段 */
export const CANVAS_CLIPBOARD_KIND = "noxrea.canvas-selection";
/** 载荷版本；语义变更必须提升，不得在同一版本内静默改变含义 */
export const CANVAS_CLIPBOARD_VERSION = 1;
/** HTML 镜像中承载载荷的属性名 */
export const CANVAS_CLIPBOARD_HTML_ATTR = "data-noxrea-canvas-selection";
/** 序列化载荷的 UTF-8 字节上限（4 MiB） */
export const CANVAS_CLIPBOARD_MAX_BYTES = 4 * 1024 * 1024;
export const CANVAS_CLIPBOARD_MAX_NODES = 2000;
export const CANVAS_CLIPBOARD_MAX_EDGES = 4000;

export type CanvasClipboardNodeType = (typeof NODE_TYPE)[keyof typeof NODE_TYPE];

/** 规范节点：只保留可迁移字段，data 为深拷贝后的内容对象 */
export interface CanvasClipboardNode {
  id: string;
  type: CanvasClipboardNodeType;
  position: { x: number; y: number };
  /** 仅有限正数尺寸；没有有效尺寸时省略 */
  style?: { width: number; height: number };
  /** 指向载荷内的组；成员保留组内相对坐标 */
  parentId?: string;
  data: Record<string, unknown>;
}

export interface CanvasClipboardEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasClipboardPayload {
  kind: typeof CANVAS_CLIPBOARD_KIND;
  version: typeof CANVAS_CLIPBOARD_VERSION;
  nodes: CanvasClipboardNode[];
  edges: CanvasClipboardEdge[];
}

export type CanvasClipboardParseFailure =
  | "empty"
  | "too-large"
  | "malformed"
  | "kind"
  | "version"
  | "shape"
  | "nodes"
  | "groups"
  | "edges"
  | "limit";

export type CanvasClipboardParseResult =
  | { ok: true; payload: CanvasClipboardPayload }
  | { ok: false; reason: CanvasClipboardParseFailure };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

const NODE_TYPE_VALUES = new Set<string>(Object.values(NODE_TYPE));

function isCanvasNodeType(value: unknown): value is CanvasClipboardNodeType {
  return typeof value === "string" && NODE_TYPE_VALUES.has(value);
}

/**
 * 引用值域校验：src / multiResultKeys 只应保存存储 key 或外部 URL。
 * blob: 是当前标签页的临时预览（跨标签页无意义且会被 revoke），
 * javascript:/vbscript: 不应进入媒体引用。
 */
function isAllowedMediaRef(value: string): boolean {
  if (value === "") return true;
  return !/^\s*(?:blob|javascript|vbscript):/i.test(value);
}

/** 生成一份与 store 脱离的 data 深拷贝（节点 data 只含可序列化普通值） */
function cloneNodeData(data: unknown): Record<string, unknown> {
  try {
    const cloned = JSON.parse(JSON.stringify(data ?? {})) as unknown;
    return isPlainObject(cloned) ? cloned : {};
  } catch {
    return {};
  }
}

/**
 * 导出规范节点：只保留 id / type / position / style / parentId / data。
 * 运行时字段（selected、measured、internals……）天然被丢弃；
 * data 内的任务绑定、上传会话（含失败原因）与未渲染的旋转/翻转状态一并剥离。
 */
export function sanitizeNodeForClipboard(node: AnyNode): CanvasClipboardNode {
  const data = cloneNodeData(node.data);
  delete data.taskBinding;
  // 上传会话不可迁移：失败原因也剥离，避免副本显示无法重试的上传失败 UI
  delete data.upload;
  delete data.rotation;
  delete data.flipH;
  delete data.flipV;

  const sanitized: CanvasClipboardNode = {
    id: node.id,
    type: node.type as CanvasClipboardNodeType,
    position: { x: node.position.x, y: node.position.y },
    data,
  };
  // style 只保留有限正数尺寸；文本节点的 minWidth/minHeight 由节点组件常量
  // 提供，不属于可迁移内容
  if (isPositiveNumber(node.style?.width) && isPositiveNumber(node.style?.height)) {
    sanitized.style = { width: node.style.width, height: node.style.height };
  }
  // 组节点恒为顶层；成员归属指向谁由选择快照决定是否保留
  if (!isGroupNodeType(node.type) && isNonEmptyString(node.parentId)) {
    sanitized.parentId = node.parentId;
  }
  return sanitized;
}

export function sanitizeEdgeForClipboard(edge: AnyEdge): CanvasClipboardEdge {
  return { id: edge.id, source: edge.source, target: edge.target };
}

function isGroupNodeType(type: string): boolean {
  return type === NODE_TYPE.GROUP;
}

/**
 * 生成系统载荷：节点必须已是规范快照；连线只保留两端都在节点集内、
 * 不连组、不自连、符合当前连接规则且不重复的边。外部上游边由内部
 * 剪贴板保留（供创建副本还原），不进入系统载荷。
 */
export function createCanvasClipboardPayload(
  nodes: CanvasClipboardNode[],
  edges: CanvasClipboardEdge[],
): CanvasClipboardPayload {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  const internalEdges = edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return false;
    if (isGroupNodeType(source.type) || isGroupNodeType(target.type)) return false;
    if (edge.source === edge.target) return false;
    if (!canConnect(source.type, target.type)) return false;
    if (!acceptsInput(target.type, target.data.source as string | undefined)) return false;
    if (edgeIds.has(edge.id)) return false;
    const pairKey = `${edge.source}\u0000${edge.target}`;
    if (pairs.has(pairKey)) return false;
    edgeIds.add(edge.id);
    pairs.add(pairKey);
    return true;
  });
  return {
    kind: CANVAS_CLIPBOARD_KIND,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes,
    edges: internalEdges,
  };
}

/** 纯文本选择的可读文本：全部节点都是文本节点时按节点顺序以空行连接 */
export function textOnlyPlainText(nodes: CanvasClipboardNode[]): string | undefined {
  if (nodes.length === 0) return undefined;
  if (!nodes.every((node) => node.type === NODE_TYPE.TEXT)) return undefined;
  const text = nodes
    .map((node) => (typeof node.data.plainText === "string" ? node.data.plainText : ""))
    .join("\n\n");
  return text.trim() ? text : undefined;
}

const utf8Encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

/** UTF-8 字节数（不依赖 Blob，SSR / jsdom 均可用） */
export function getUtf8ByteLength(value: string): number {
  if (utf8Encoder) return utf8Encoder.encode(value).byteLength;
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function encodeCanvasClipboardPayload(payload: CanvasClipboardPayload): string {
  return JSON.stringify(payload);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * HTML 镜像：属性里放同一份转义 JSON，span 内只放可读文本。
 * 非文本选择为空 span，任何可见区域都不出现节点 JSON。
 */
export function buildCanvasClipboardHtml(
  payload: CanvasClipboardPayload,
  plainText?: string,
): string {
  const json = escapeHtmlAttribute(encodeCanvasClipboardPayload(payload));
  const body = plainText ? escapeHtmlText(plainText).replace(/\n/g, "<br>") : "";
  return `<span ${CANVAS_CLIPBOARD_HTML_ATTR}="${json}">${body}</span>`;
}

function hasValidBaseFields(
  type: CanvasClipboardNodeType,
  data: Record<string, unknown>,
): boolean {
  if (typeof data.label !== "string") return false;

  switch (type) {
    case NODE_TYPE.TEXT:
      return typeof data.content === "string" && typeof data.plainText === "string";
    case NODE_TYPE.IMAGE:
      return (
        typeof data.src === "string" &&
        isAllowedMediaRef(data.src) &&
        typeof data.lockAspectRatio === "boolean" &&
        isNonNegativeNumber(data.naturalWidth) &&
        isNonNegativeNumber(data.naturalHeight)
      );
    case NODE_TYPE.VIDEO:
      return (
        typeof data.src === "string" &&
        isAllowedMediaRef(data.src) &&
        isNonNegativeNumber(data.naturalWidth) &&
        isNonNegativeNumber(data.naturalHeight)
      );
    case NODE_TYPE.AUDIO:
      return typeof data.src === "string" && isAllowedMediaRef(data.src);
    case NODE_TYPE.GROUP:
    case NODE_TYPE.DIRECTOR:
      return true;
  }
  return false;
}

/** 已知可选字段的类型校验；未知字段按原值保留（协议不为全量 schema 背书） */
function hasValidOptionalFields(
  type: CanvasClipboardNodeType,
  data: Record<string, unknown>,
): boolean {
  if (data.createdAt !== undefined && !isNonNegativeNumber(data.createdAt)) return false;
  if (data.fileSize !== undefined && !isNonNegativeNumber(data.fileSize)) return false;
  if (data.duration !== undefined && !isNonNegativeNumber(data.duration)) return false;
  if (data.hasAudio !== undefined && typeof data.hasAudio !== "boolean") return false;
  if (data.genSettings !== undefined && !isPlainObject(data.genSettings)) return false;
  if (data.source !== undefined && !["upload", "generate", "derived"].includes(data.source as string)) {
    return false;
  }
  if (data.color !== undefined && typeof data.color !== "string") return false;
  if (data.multiResultTotalCount !== undefined && !isNonNegativeInteger(data.multiResultTotalCount)) {
    return false;
  }
  if (data.multiResultKeys !== undefined) {
    if (
      !Array.isArray(data.multiResultKeys) ||
      !data.multiResultKeys.every(
        (key) => isNonEmptyString(key) && isAllowedMediaRef(key),
      )
    ) {
      return false;
    }
  }
  if (data.pendingNaturalSize !== undefined) {
    const size = data.pendingNaturalSize;
    if (
      !isPlainObject(size) ||
      !isPositiveNumber(size.width) ||
      !isPositiveNumber(size.height)
    ) {
      return false;
    }
  }
  if (type === NODE_TYPE.DIRECTOR && data.directorState !== undefined) {
    if (!isPlainObject(data.directorState)) return false;
  }
  return true;
}

function normalizeClipboardNode(value: unknown): CanvasClipboardNode | null {
  if (!isPlainObject(value)) return null;
  const { id, type, position, style, parentId, data } = value;
  if (!isNonEmptyString(id) || !isCanvasNodeType(type)) return null;
  if (!isPlainObject(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
    return null;
  }
  if (!isPlainObject(data)) return null;
  if (parentId !== undefined && !isNonEmptyString(parentId)) return null;
  // 组不嵌套：组节点不得有 parentId
  if (type === NODE_TYPE.GROUP && parentId !== undefined) return null;

  let normalizedStyle: { width: number; height: number } | undefined;
  if (style !== undefined) {
    if (!isPlainObject(style)) return null;
    if (!isPositiveNumber(style.width) || !isPositiveNumber(style.height)) return null;
    normalizedStyle = { width: style.width, height: style.height };
  }
  if (!hasValidBaseFields(type, data) || !hasValidOptionalFields(type, data)) return null;

  // 导入时同样剥离运行时/瞬时状态：不把未知顶层字段展开进 store，
  // 也不让复制品继承生成任务、上传会话（含失败原因）或未渲染的旋转/翻转状态
  const normalizedData: Record<string, unknown> = { ...data };
  delete normalizedData.taskBinding;
  delete normalizedData.upload;
  delete normalizedData.rotation;
  delete normalizedData.flipH;
  delete normalizedData.flipV;

  const node: CanvasClipboardNode = {
    id,
    type,
    position: { x: position.x, y: position.y },
    data: normalizedData,
  };
  if (normalizedStyle) node.style = normalizedStyle;
  if (parentId !== undefined) node.parentId = parentId;
  return node;
}

/**
 * 解析并整包校验系统载荷。任何结构、版本、分组、连线或上限错误都返回
 * 失败；调用方不得部分导入、不得降级为文本。
 */
export function parseCanvasClipboard(json: string): CanvasClipboardParseResult {
  if (json.trim() === "") return { ok: false, reason: "empty" };
  if (getUtf8ByteLength(json) > CANVAS_CLIPBOARD_MAX_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "shape" };
  if (parsed.kind !== CANVAS_CLIPBOARD_KIND) return { ok: false, reason: "kind" };
  if (parsed.version !== CANVAS_CLIPBOARD_VERSION) return { ok: false, reason: "version" };
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return { ok: false, reason: "shape" };
  }
  if (
    parsed.nodes.length === 0 ||
    parsed.nodes.length > CANVAS_CLIPBOARD_MAX_NODES ||
    parsed.edges.length > CANVAS_CLIPBOARD_MAX_EDGES
  ) {
    return { ok: false, reason: "limit" };
  }

  const nodes: CanvasClipboardNode[] = [];
  const nodeById = new Map<string, CanvasClipboardNode>();
  for (const value of parsed.nodes) {
    const node = normalizeClipboardNode(value);
    if (!node) return { ok: false, reason: "nodes" };
    if (nodeById.has(node.id)) return { ok: false, reason: "nodes" };
    nodeById.set(node.id, node);
    nodes.push(node);
  }

  // 父必须是载荷内的组；组必须有成员；组不得有 parentId（上一段已拒绝）
  const memberCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const parent = nodeById.get(node.parentId);
    if (!parent || parent.type !== NODE_TYPE.GROUP) return { ok: false, reason: "groups" };
    memberCounts.set(node.parentId, (memberCounts.get(node.parentId) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (node.type === NODE_TYPE.GROUP && (memberCounts.get(node.id) ?? 0) === 0) {
      return { ok: false, reason: "groups" };
    }
  }

  const edges: CanvasClipboardEdge[] = [];
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const value of parsed.edges) {
    if (!isPlainObject(value)) return { ok: false, reason: "edges" };
    const { id, source, target } = value;
    if (!isNonEmptyString(id) || !isNonEmptyString(source) || !isNonEmptyString(target)) {
      return { ok: false, reason: "edges" };
    }
    if (source === target) return { ok: false, reason: "edges" };
    const sourceNode = nodeById.get(source);
    const targetNode = nodeById.get(target);
    if (
      !sourceNode ||
      !targetNode ||
      isGroupNodeType(sourceNode.type) ||
      isGroupNodeType(targetNode.type)
    ) {
      return { ok: false, reason: "edges" };
    }
    if (!canConnect(sourceNode.type, targetNode.type)) {
      return { ok: false, reason: "edges" };
    }
    if (!acceptsInput(targetNode.type, targetNode.data.source as string | undefined)) {
      return { ok: false, reason: "edges" };
    }
    if (edgeIds.has(id)) return { ok: false, reason: "edges" };
    const pairKey = `${source}\u0000${target}`;
    if (pairs.has(pairKey)) return { ok: false, reason: "edges" };
    edgeIds.add(id);
    pairs.add(pairKey);
    edges.push({ id, source, target });
  }

  return {
    ok: true,
    payload: {
      kind: CANVAS_CLIPBOARD_KIND,
      version: CANVAS_CLIPBOARD_VERSION,
      nodes,
      edges,
    },
  };
}
