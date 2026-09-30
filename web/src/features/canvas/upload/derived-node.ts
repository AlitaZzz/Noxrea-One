/**
 * 派生节点创建：从「已有 URL」或「源节点」生成新图片节点并连线。
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
import { absoluteNodeOf, toAbsoluteNodes } from "@/features/canvas/shared/group-bounds";
import type { AnyEdge, AnyNode, ImageNode, TextNode } from "@/features/canvas/types";
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
  edges: AnyEdge[];
  addNodes: (nodes: AnyNode[], options?: { skipHistory?: boolean }) => void;
  setEdges: (edges: AnyEdge[], options?: { skipHistory?: boolean }) => void;
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
 * options.label 设置派生节点标题（如生成面板预设用预设名）。
 * 返回创建的节点；源节点不存在时返回 null，提示方式由调用方决定。
 */
export function spawnPromptDerivedNode(
  sourceId: string,
  prompt: string,
  nodeFactory: (position: { x: number; y: number }) => TextNode | ImageNode,
  storeApi: CanvasStoreApi,
  options?: { label?: string },
): TextNode | ImageNode | null {
  const source = storeApi.nodes.find((n) => n.id === sourceId);
  if (!source) return null;
  const node = nodeFactory({ x: 0, y: 0 });
  // 以节点默认显示尺寸做宫格找空位：重复「创作」/模板派生不再叠在同一处
  const rect = nodeRectOf(node);
  node.position = findDerivedSlot(
    toAbsoluteNodes(storeApi.nodes),
    absoluteNodeOf(source, storeApi.nodes),
    { width: rect.width, height: rect.height },
  );
  const gen = node.data.genSettings;
  if (gen) gen.prompt = prompt;
  if (options?.label) node.data.label = options.label;
  storeApi.addNodes([node]);
  storeApi.setEdges([...storeApi.edges, createEdge(sourceId, node.id)]);
  return node;
}

/**
 * 从已有 URL 创建图片节点 -> 写入 store -> 连线到源节点。
 *
 * 适用于「URL 已存在、无需再上传」的场景（如导演视图把已上传的截图发送到画布）。
 * 需要走上传的场景请用 runMediaUpload 的 derived-node sink。
 *
 * @param sourceId    源节点 ID（新节点连线到它）
 * @param url         已存在的图片 URL
 * @param naturalW    图片自然宽度
 * @param naturalH    图片自然高度
 * @param labelSuffix 标题后缀
 * @param storeApi    由调用方注入的 store 操作接口
 */
export function createNodeFromUrl(
  sourceId: string,
  url: string,
  naturalW: number,
  naturalH: number,
  labelSuffix: string,
  storeApi: CanvasStoreApi,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
  labelOverride?: string,
): AnyNode {
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);
  const label = resolveDerivedLabel(origNode, labelSuffix, labelOverride);
  const node = createImageNode({ x: 0, y: 0 }, url);
  node.data.label = label;
  node.data.naturalWidth = naturalW;
  node.data.naturalHeight = naturalH;
  if (extraNodeData) Object.assign(node.data, extraNodeData);
  // 零尺寸保护：degenerate 输入（0 宽/高）按 300 兜底，避免节点塌缩为 0
  const size = computeNodeSize(naturalW > 0 ? naturalW : 300, naturalH > 0 ? naturalH : 300);
  node.style = size;
  // 宫格找空位：重复派生（连续抽帧/截图等）不再叠在同一处
  node.position = resolveDerivedPosition(origNode, positionOverride, {
    nodes: storeApi.nodes,
    size,
  });

  storeApi.addNodes([node]);
  storeApi.setEdges([...storeApi.edges, createEdge(sourceId, node.id)]);

  return node;
}

/** createXxxNodeFromUrl 的可选行为 */
export interface CreateNodeOptions {
  /** 是否自动在 sourceId 与新节点之间建立一条边。默认 true */
  connectToSource?: boolean;
  /** 不写入撤销栈。批量创建（如音轨分离需多次派生）时使用 */
  skipHistory?: boolean;
  /**
   * 仅构建节点对象并返回，不写入 store。
   * 调用方拿到多个节点后自行一次性 addNodes + setEdges，
   * 保证同批派生只产生一条撤销记录（与宫格切分一致）。默认 false。
   */
  write?: boolean;
}

/**
 * 从已有 URL 创建音频节点 -> 写入 store -> 连线到源节点。
 *
 * 用于「服务端已落盘、前端直接引用」的场景（如音视频分离产出的音轨），
 * 无需再走上传管道。
 */
export function createAudioNodeFromUrl(
  sourceId: string,
  url: string,
  labelSuffix: string,
  storeApi: CanvasStoreApi,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
  labelOverride?: string,
  options?: CreateNodeOptions,
): AnyNode {
  const connectToSource = options?.connectToSource !== false;
  const skipHistory = options?.skipHistory === true;
  const write = options?.write !== false;
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);
  const label = resolveDerivedLabel(origNode, labelSuffix, labelOverride);

  const node = createAudioNode({ x: 0, y: 0 }, url);
  node.data.label = label;
  if (extraNodeData) Object.assign(node.data, extraNodeData);
  // 宫格找空位：连续截取/变速等重复派生不再叠在同一处
  node.position = resolveDerivedPosition(origNode, positionOverride, {
    nodes: storeApi.nodes,
    size: { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT },
  });

  if (write) {
    storeApi.addNodes([node], { skipHistory });
    if (connectToSource) {
      storeApi.setEdges([...storeApi.edges, createEdge(sourceId, node.id)], { skipHistory });
    }
  }

  return node;
}

/**
 * 从已有 URL 创建视频节点 -> 写入 store -> 连线到源节点。
 *
 * 用于音量分离产出的静音视频等「服务端已落盘」的场景。
 */
export function createVideoNodeFromUrl(
  sourceId: string,
  url: string,
  naturalW: number,
  naturalH: number,
  labelSuffix: string,
  storeApi: CanvasStoreApi,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
  labelOverride?: string,
  options?: CreateNodeOptions,
): AnyNode {
  const connectToSource = options?.connectToSource !== false;
  const skipHistory = options?.skipHistory === true;
  const write = options?.write !== false;
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);
  const label = resolveDerivedLabel(origNode, labelSuffix, labelOverride);

  const node = createVideoNode({ x: 0, y: 0 }, url);
  node.data.label = label;
  node.data.naturalWidth = naturalW;
  node.data.naturalHeight = naturalH;
  if (extraNodeData) Object.assign(node.data, extraNodeData);
  // 零尺寸保护：degenerate 输入（0 宽/高）按 300 兜底，避免节点塌缩为 0
  const size = computeNodeSize(naturalW > 0 ? naturalW : 300, naturalH > 0 ? naturalH : 300);
  node.style = size;
  // 宫格找空位：重复派生（连续截取/裁剪等）不再叠在同一处
  node.position = resolveDerivedPosition(origNode, positionOverride, {
    nodes: storeApi.nodes,
    size,
  });

  if (write) {
    storeApi.addNodes([node], { skipHistory });
    if (connectToSource) {
      storeApi.setEdges([...storeApi.edges, createEdge(sourceId, node.id)], { skipHistory });
    }
  }

  return node;
}
