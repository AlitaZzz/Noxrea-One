/**
 * 派生节点创建：从「已有引用值」或「源节点」生成新媒体节点（图片 / 音频 / 视频）并连线。
 *
 * 这是统一上传管道的「落库」半边（另一半是上传本身）。
 * 供管道（derived sink）与导演视图「截图发送到画布」复用。
 */
"use client";

import {
  createAudioNode,
  createEdge,
  createImageNode,
  createVideoNode,
} from "@/features/canvas/node-defaults";
import { toAbsoluteNodes } from "@/features/canvas/shared/group-bounds";
import type { HistoryPushOptions } from "@/features/canvas/stores/canvas-store";
import { withHistoryBatch } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, AnyNode, ImageNode, TextNode, VideoNode } from "@/features/canvas/types";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH } from "@/lib/constants";
import i18n from "@/lib/i18n/config";
import { stripMediaExtension } from "@/lib/utils/file-name";
import {
  computeNodeSize,
  findDerivedSlot,
  nodeRectOf,
} from "@/lib/utils/image-utils";

/** 同批派生多个节点时的垂直间隙（px），避免产物互相重叠 */
export const DERIVED_BASE_GAP_Y = 24;

/** Store 依赖注入接口：由调用方注入所需操作，避免 lib 层直连 store */
export interface CanvasStoreApi {
  nodes: AnyNode[];
  addNodes: (nodes: AnyNode[], options?: HistoryPushOptions) => void;
  /** 追加连线；store 在写入时读取最新 edges，调用方无需持有快照 */
  addEdges: (edges: AnyEdge[], options?: HistoryPushOptions) => void;
}

/** 节点 + 连线写入的单一实现：批量与单节点入口共享同一落库顺序 */
function applyDerivedWrite(
  sourceId: string,
  nodes: AnyNode[],
  storeApi: CanvasStoreApi,
): void {
  storeApi.addNodes(nodes);
  storeApi.addEdges(nodes.map((node) => createEdge(sourceId, node.id)));
}

/**
 * 将派生节点与其到源节点的连线作为同一批写入。
 * 调用方以 `write: false` 构建若干节点后，用本函数一次性落库；
 * 批量守卫把节点与边合并为一条撤销记录（离散操作必定入栈）。
 */
export function commitDerivedNodes(
  sourceId: string,
  nodes: AnyNode[],
  storeApi: CanvasStoreApi,
): void {
  withHistoryBatch(() => applyDerivedWrite(sourceId, nodes, storeApi));
}

/**
 * 派生节点标题：默认「源节点名（去扩展名）+ 后缀」，labelOverride 优先。
 * 源名取节点显示用的标题；label 为空时回退到类型默认名（图片/视频/音频/文本），
 * 与节点组件标题栏的显示兜底（data.label || t("node.xxx")）保持一致。
 */
const NODE_TYPE_NAME_KEY: Record<string, string> = {
  "image-node": "node.image",
  "video-node": "node.video",
  "audio-node": "node.audio",
  "text-node": "node.text",
  "director-node": "node.director",
};

export function resolveDerivedLabel(
  origNode: AnyNode | undefined,
  labelSuffix: string,
  labelOverride?: string,
): string {
  if (labelOverride !== undefined) return labelOverride;
  const origData = origNode?.data as { label?: string } | undefined;
  const typeKey = origNode ? NODE_TYPE_NAME_KEY[origNode.type] : undefined;
  const origName = origData?.label || i18n.t(typeKey ?? "node.image");
  return stripMediaExtension(origName) + labelSuffix;
}

/** 派生落位的碰撞上下文：传入后按「宫格找空位」计算，避免与现有节点重叠 */
export interface DerivedCollision {
  /** 需要避开的节点（画布现有节点，可含同批已落位的节点） */
  nodes: AnyNode[];
  /** 新节点的显示尺寸 */
  size: { width: number; height: number };
}

/**
 * 派生节点位置：显式 override 优先，否则按宫格找空位
 * （源节点右侧基准点起行优先扫描，被占则顺延到下一空位）。
 * 落位在绝对坐标空间进行：源节点与避让集先换算为绝对坐标视图
 * （lib 层几何函数不感知分组模型）。
 */
export function resolveDerivedPosition(
  origNode: AnyNode | undefined,
  positionOverride: { x: number; y: number } | undefined,
  collision: DerivedCollision,
): { x: number; y: number } {
  if (positionOverride) return positionOverride;
  const absNodes = toAbsoluteNodes(collision.nodes);
  const absSource = origNode
    ? absNodes.find((n) => n.id === origNode.id) ?? origNode
    : undefined;
  return findDerivedSlot(absNodes, absSource, collision.size);
}

/**
 * 提示词模板派生节点：在源节点右侧创建新节点、预填提示词、连线入库。
 * 供打光 / 多角度面板与图片节点的模板工具条复用；nodeFactory 决定节点类型
 * （createImageNode / createTextNode），两者的默认 genSettings 均含 prompt 字段。
 * options.label 必填：由调用方提供操作名或预设名，创建时即写入节点标题。
 * 返回创建的节点；源节点不存在时返回 null，提示方式由调用方决定。
 */
export function spawnPromptDerivedNode(
  sourceId: string,
  prompt: string,
  nodeFactory: (position: { x: number; y: number }) => TextNode | ImageNode,
  storeApi: CanvasStoreApi,
  options: { label: string },
): TextNode | ImageNode | null {
  const source = storeApi.nodes.find((n) => n.id === sourceId);
  if (!source) return null;
  const node = nodeFactory({ x: 0, y: 0 });
  // 以节点默认显示尺寸做宫格找空位：重复「创作」/模板派生不再叠在同一处
  const rect = nodeRectOf(node);
  node.position = resolveDerivedPosition(source, undefined, {
    nodes: storeApi.nodes,
    size: { width: rect.width, height: rect.height },
  });
  const gen = node.data.genSettings;
  if (gen) gen.prompt = prompt;
  node.data.label = options.label;
  commitDerivedNodes(sourceId, [node], storeApi);
  return node;
}

/**
 * 单节点派生的写入出口：离散创建必须走批量守卫，
 * 否则距上次压栈不足 300ms 时会被节流吞掉独立撤销记录。
 */
function writeDerivedNode(
  sourceId: string,
  node: AnyNode,
  storeApi: CanvasStoreApi,
  options?: CreateDerivedNodeParams["options"],
): void {
  if (options?.write === false) return;
  commitDerivedNodes(sourceId, [node], storeApi);
}

/** 派生节点创建入参：引用值已存在；默认构建并写入，`options.write === false` 时仅构建 */
export interface CreateDerivedNodeParams {
  /** 源节点 ID（新节点连线到它） */
  sourceId: string;
  /** 引用值：存储 key 或外部 URL（与节点 data.src 同值域；展示 URL 由渲染期派生） */
  ref: string;
  /** 标题后缀 */
  labelSuffix: string;
  /** 由调用方注入的 store 操作接口 */
  storeApi: CanvasStoreApi;
  /** 追加写入节点 data 的字段 */
  extraNodeData?: Record<string, unknown>;
  /** 显式落位（绝对坐标）；缺省按宫格找空位 */
  positionOverride?: { x: number; y: number };
  /** 标题覆盖（优先于「源节点名 + 后缀」） */
  labelOverride?: string;
  /**
   * 写入行为：`write: false` 仅构建节点，不写入 store；
   * 缺省写入并连线，产生一条独立撤销记录。
   * 批量创建时由调用方以 `write: false` 构建多个节点后，
   * 一次性 `commitDerivedNodes`。
   */
  options?: { write?: boolean };
}

/** 带自然尺寸的派生媒体节点入参 */
export interface CreateVisualNodeParams extends CreateDerivedNodeParams {
  /** 媒体自然宽度 */
  naturalWidth: number;
  /** 媒体自然高度 */
  naturalHeight: number;
}

/**
 * 派生节点公共收尾：标题、附加 data、落位与写入。
 * 三种节点共用同一写入语义，差异只在各自节点工厂与显示尺寸。
 */
function finishDerivedNode<T extends AnyNode>(
  node: T,
  params: CreateDerivedNodeParams,
  size: { width: number; height: number },
): T {
  const { sourceId, labelSuffix, storeApi, extraNodeData, positionOverride, labelOverride, options } = params;
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);
  node.data.label = resolveDerivedLabel(origNode, labelSuffix, labelOverride);
  if (extraNodeData) Object.assign(node.data, extraNodeData);
  // 宫格找空位：重复派生（连续抽帧/截图/截取/变速/裁剪等）不再叠在同一处
  node.position = resolveDerivedPosition(origNode, positionOverride, {
    nodes: storeApi.nodes,
    size,
  });
  writeDerivedNode(sourceId, node, storeApi, options);
  return node;
}

/** 带自然尺寸的媒体节点收尾：先按自然尺寸设置显示尺寸，再走公共收尾 */
function finishVisualNode<T extends ImageNode | VideoNode>(
  node: T,
  params: CreateVisualNodeParams,
): T {
  const { naturalWidth, naturalHeight } = params;
  node.data.naturalWidth = naturalWidth;
  node.data.naturalHeight = naturalHeight;
  // 零尺寸保护：degenerate 输入（0 宽/高）按 300 兜底，避免节点塌缩为 0
  const size = computeNodeSize(naturalWidth > 0 ? naturalWidth : 300, naturalHeight > 0 ? naturalHeight : 300);
  node.style = size;
  return finishDerivedNode(node, params, size);
}

/**
 * 从已有引用值创建图片节点 -> 写入 store -> 连线到源节点。
 *
 * 适用于「引用值已存在、无需再上传」的场景（如导演视图把已上传的截图发送到画布）。
 * 需要走上传的场景请用 runMediaUpload 的 derived-node sink。
 */
export function createImageNodeFromRef(params: CreateVisualNodeParams): AnyNode {
  return finishVisualNode(createImageNode({ x: 0, y: 0 }, params.ref), params);
}

/**
 * 从已有引用值创建音频节点 -> 写入 store -> 连线到源节点。
 *
 * 用于「服务端已落盘、前端直接引用」的场景（如音视频分离产出的音轨），
 * 无需再走上传管道。引用值必须是存储 key 或外部 URL；编辑接口返回的
 * `/api/files/` 展示 URL 不得写入节点（持久化值域见 storage-reference-key-unification）。
 */
export function createAudioNodeFromRef(params: CreateDerivedNodeParams): AnyNode {
  return finishDerivedNode(
    createAudioNode({ x: 0, y: 0 }, params.ref),
    params,
    { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT },
  );
}

/**
 * 从已有引用值创建视频节点 -> 写入 store -> 连线到源节点。
 *
 * 用于音量分离产出的静音视频等「服务端已落盘」的场景。引用值必须是存储 key
 * 或外部 URL；编辑接口返回的 `/api/files/` 展示 URL 不得写入节点。
 */
export function createVideoNodeFromRef(params: CreateVisualNodeParams): AnyNode {
  return finishVisualNode(createVideoNode({ x: 0, y: 0 }, params.ref), params);
}
