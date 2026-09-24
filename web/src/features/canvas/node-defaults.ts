/**
 * 节点与连线的工厂方法。
 * 集中定义各类节点的默认数据、默认尺寸与 ID 生成规则，
 * 并提供节点再制（duplicate）与连线创建函数。
 */
import {
  type AnyNode,
  type AudioNode,
  type AudioNodeData,
  type DirectorNode,
  type GroupNode,
  type GroupNodeData,
  type ImageGenSettings,
  type ImageNode,
  type ImageNodeData,
  type TextGenSettings,
  type TextNode,
  type TextNodeData,
  type VideoGenSettings,
  type VideoNode,
  type VideoNodeData,
} from "@/features/canvas/types";
import {
  AUDIO_NODE_HEIGHT,
  AUDIO_NODE_WIDTH,
  DEFAULT_NODE_CONTENT_HEIGHT,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  DIRECTOR_NODE_DEFAULT_HEIGHT,
  DIRECTOR_NODE_DEFAULT_WIDTH,
  EDGE_BASE_COLOR,
  TEXT_NODE_DEFAULT_HEIGHT,
  TEXT_NODE_DEFAULT_WIDTH,
  TEXT_NODE_MIN_HEIGHT,
  TEXT_NODE_MIN_WIDTH,
} from "@/lib/constants";
import { NODE_TYPE } from "@/lib/constants";
import i18n from "@/lib/i18n/config";

// id 形如 "t-3xK9qP2mAbZc1"：单字母类型前缀便于一眼识别归属，
// 随机段不泄露创建时间；会话内去重守卫兜底极小概率的随机碰撞。
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const usedIds = new Set<string>();
function uid(prefix: string) {
  const bytes = new Uint8Array(13);
  let id: string;
  do {
    crypto.getRandomValues(bytes);
    id = `${prefix}-${Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("")}`;
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

export function createTextNode(position: { x: number; y: number }): TextNode {
  return {
    id: uid("t"),
    type: NODE_TYPE.TEXT,
    position,
    data: {
      label: "",
      content: "",
      plainText: "",
      createdAt: Date.now(),
      genSettings: { kind: "text", prompt: "", modelKey: "", refOrder: [], refAudioOrder: [], refVideoOrder: [] } satisfies TextGenSettings,
    } as TextNodeData,
    style: {
      width: TEXT_NODE_DEFAULT_WIDTH,
      height: TEXT_NODE_DEFAULT_HEIGHT,
      minWidth: TEXT_NODE_MIN_WIDTH,
      minHeight: TEXT_NODE_MIN_HEIGHT,
    },
  };
}

export function createImageNode(
  position: { x: number; y: number },
  src?: string
): ImageNode {
  return {
    id: uid("i"),
    type: NODE_TYPE.IMAGE,
    position,
    data: {
      label: "",
      src: src || "",
      lockAspectRatio: true,
      naturalWidth: DEFAULT_NODE_WIDTH,
      naturalHeight: DEFAULT_NODE_CONTENT_HEIGHT,
      createdAt: Date.now(),
      genSettings: { kind: "image", prompt: "", modelKey: "", quality: "", resolution: "", ratio: "", refOrder: [], n: 1 } satisfies ImageGenSettings,
    } as ImageNodeData,
    style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
  };
}

export function createVideoNode(
  position: { x: number; y: number },
  src?: string
): VideoNode {
  return {
    id: uid("v"),
    type: NODE_TYPE.VIDEO,
    position,
    data: {
      label: "",
      src: src || "",
      naturalWidth: 320,
      naturalHeight: 180,
      createdAt: Date.now(),
      genSettings: { kind: "video", prompt: "", modelKey: "", resolution: "", ratio: "", seconds: 5, generateAudio: false, refOrder: [], refAudioOrder: [], refVideoOrder: [], n: 1 } satisfies VideoGenSettings,
    } as VideoNodeData,
    style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
  };
}

export function createAudioNode(
  position: { x: number; y: number },
  src?: string
): AudioNode {
  return {
    id: uid("a"),
    type: NODE_TYPE.AUDIO,
    position,
    data: {
      label: "",
      src: src || "",
      createdAt: Date.now(),
    } as AudioNodeData,
    style: { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT },
  };
}

export function directorNode(position: { x: number; y: number }): DirectorNode {
  return {
    id: uid("d"),
    type: NODE_TYPE.DIRECTOR,
    position,
    data: { label: "", createdAt: Date.now() },
    style: { width: DIRECTOR_NODE_DEFAULT_WIDTH, height: DIRECTOR_NODE_DEFAULT_HEIGHT },
  };
}

export function createGroupNode(
  position: { x: number; y: number },
  size: { width: number; height: number },
  label?: string
): GroupNode {
  return {
    id: uid("g"),
    type: NODE_TYPE.GROUP,
    position,
    data: { label: label || "" } as GroupNodeData,
    style: { width: size.width, height: size.height },
    className: "react-flow__node-group",
  };
}

// 复制节点时复用新建节点的 id 前缀约定，保持副本与原节点同一类型字母
const NODE_ID_PREFIX: Record<string, string> = {
  [NODE_TYPE.IMAGE]: "i",
  [NODE_TYPE.VIDEO]: "v",
  [NODE_TYPE.AUDIO]: "a",
  [NODE_TYPE.TEXT]: "t",
  [NODE_TYPE.GROUP]: "g",
  [NODE_TYPE.DIRECTOR]: "d",
};

export function duplicateNode(
  node: AnyNode,
  offset: { x: number; y: number }
): AnyNode {
  const prefix = NODE_ID_PREFIX[node.type] ?? node.type ?? "copy";
  const cloned = JSON.parse(JSON.stringify(node)) as AnyNode & { data: Record<string, unknown> };
  // 副本不继承「进行中」的瞬时状态：
  // - taskBinding：生成任务归属原节点，副本没有对应任务，
  //   保留会让副本永远停在「生成中」遮罩，并连带全局禁用撤销 / 重做。
  // - upload：上传进度 / 失败原因与 previewUrl（blob: URL）同样属于原节点，
  //   原节点上传结束后管道会 revoke 该 URL，副本会指向已回收的地址。
  // 已完成的静态内容（src / content / genSettings 等）保持不变。
  if (cloned.data) {
    delete cloned.data.taskBinding;
    const upload = cloned.data.upload as
      | { uploading?: boolean; progress?: number; previewUrl?: string; error?: unknown }
      | undefined;
    if (upload) {
      if (upload.error === undefined) {
        // 上传中：进度与 blob 预览都属于原节点（结束后 previewUrl 会被 revoke），副本不能继承
        delete cloned.data.upload;
      } else {
        // 上传失败：保留失败原因，副本仍显示「上传失败」提示；
        // 但丢弃原节点的 blob 预览与进度（重试上下文已失效，预览也可能已被回收）
        delete upload.previewUrl;
        upload.uploading = false;
        upload.progress = 0;
      }
    }
  }
  return {
    ...cloned,
    id: uid(prefix),
    position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    selected: false,
  };
}

/** 创建统一样式的连接线（deletable、静态、中性灰；不画箭头，方向由流光表达） */
export function createEdge(
  source: string,
  target: string,
  options?: { id?: string; type?: string; style?: Record<string, unknown> }
) {
  const edgeId = options?.id || uid("e");
  return {
    id: edgeId,
    source,
    target,
    type: options?.type || "deletable",
    animated: false,
    style: { stroke: EDGE_BASE_COLOR, strokeWidth: 2, ...(options?.style || {}) },
  };
}
