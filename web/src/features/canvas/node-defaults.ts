/**
 * 节点与连线的工厂方法。
 * 集中定义各类节点的默认数据、默认尺寸与 ID 生成规则，
 * 并提供节点再制（duplicate）与连线创建函数。
 */
import { MarkerType } from "@xyflow/react";

import i18n from "@/lib/i18n/config";
import {
  AUDIO_NODE_HEIGHT,
  AUDIO_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  DIRECTOR_NODE_DEFAULT_HEIGHT,
  DIRECTOR_NODE_DEFAULT_WIDTH,
  TEXT_NODE_DEFAULT_HEIGHT,
  TEXT_NODE_DEFAULT_WIDTH,
  TEXT_NODE_MIN_HEIGHT,
  TEXT_NODE_MIN_WIDTH,
} from "@/lib/constants";
import { NODE_TYPE } from "@/lib/constants";
import {
  type AnyNode,
  type AudioNode,
  type AudioNodeData,
  type DirectorNode,
  type GroupNode,
  type GroupNodeData,
  type ImageNode,
  type ImageNodeData,
  type TextNode,
  type TextNodeData,
  type VideoNode,
  type VideoNodeData,
} from "@/features/canvas/types";

let _idCounter = 0;
function uid(prefix: string) {
  _idCounter++;
  return `${prefix}_${Date.now()}_${_idCounter}`;
}

export function createTextNode(position: { x: number; y: number }): TextNode {
  return {
    id: uid("text"),
    type: NODE_TYPE.TEXT,
    position,
    data: { label: "", content: "" } as TextNodeData,
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
    id: uid("img"),
    type: NODE_TYPE.IMAGE,
    position,
    data: {
      label: "",
      src: src || "",
      lockAspectRatio: true,
      naturalWidth: DEFAULT_NODE_WIDTH,
      naturalHeight: DEFAULT_NODE_HEIGHT,
      alt: "",
    } as ImageNodeData,
    style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
  };
}

export function createVideoNode(
  position: { x: number; y: number },
  src?: string
): VideoNode {
  return {
    id: uid("vid"),
    type: NODE_TYPE.VIDEO,
    position,
    data: {
      label: "",
      src: src || "",
      naturalWidth: 320,
      naturalHeight: 180,
      alt: "",
    } as VideoNodeData,
    style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
  };
}

export function createAudioNode(
  position: { x: number; y: number },
  src?: string
): AudioNode {
  return {
    id: uid("aud"),
    type: NODE_TYPE.AUDIO,
    position,
    data: {
      label: "",
      src: src || "",
      alt: "",
    } as AudioNodeData,
    style: { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT },
  };
}

export function directorNode(position: { x: number; y: number }): DirectorNode {
  return {
    id: uid("dir"),
    type: NODE_TYPE.DIRECTOR,
    position,
    data: { label: "" },
    style: { width: DIRECTOR_NODE_DEFAULT_WIDTH, height: DIRECTOR_NODE_DEFAULT_HEIGHT },
  };
}

export function createGroupNode(
  position: { x: number; y: number },
  size: { width: number; height: number },
  label?: string
): GroupNode {
  return {
    id: uid("group"),
    type: NODE_TYPE.GROUP,
    position,
    data: { label: label || "" } as GroupNodeData,
    style: { width: size.width, height: size.height },
    className: "react-flow__node-group",
  };
}

// 复制节点时复用新建节点的 id 前缀约定，避免 image 节点复制后变成 "image-node_" 前缀
const NODE_ID_PREFIX: Record<string, string> = {
  [NODE_TYPE.IMAGE]: "img",
  [NODE_TYPE.VIDEO]: "vid",
  [NODE_TYPE.AUDIO]: "aud",
  [NODE_TYPE.TEXT]: "text",
  [NODE_TYPE.GROUP]: "group",
  [NODE_TYPE.DIRECTOR]: "dir",
};

export function duplicateNode(
  node: AnyNode,
  offset: { x: number; y: number }
): AnyNode {
  const prefix = NODE_ID_PREFIX[node.type] ?? node.type ?? "copy";
  return {
    ...JSON.parse(JSON.stringify(node)),
    id: uid(prefix),
    position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    selected: false,
  };
}

/** 创建统一样式的连接线（deletable、静态、灰色箭头） */
export function createEdge(
  source: string,
  target: string,
  options?: { id?: string; type?: string; style?: Record<string, unknown>; markerEnd?: Record<string, unknown> }
) {
  const edgeId = options?.id || `edge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    id: edgeId,
    source,
    target,
    type: options?.type || "deletable",
    animated: false,
    style: { stroke: "#666", strokeWidth: 2, ...(options?.style || {}) },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#666", ...(options?.markerEnd || {}) },
  };
}
