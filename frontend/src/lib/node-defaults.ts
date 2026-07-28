import { MarkerType } from "@xyflow/react";

import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "@/lib/constants";
import {
  type AnyNode,
  type DirectorNode,
  type GroupNode,
  type GroupNodeData,
  type ImageNode,
  type ImageNodeData,
  NODE_TYPE,
  type TextNode,
  type TextNodeData,
  type VideoNode,
  type VideoNodeData,
} from "@/lib/types";

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
    style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
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

export function directorNode(position: { x: number; y: number }): DirectorNode {
  return {
    id: uid("dir"),
    type: NODE_TYPE.DIRECTOR,
    position,
    data: { label: "" },
    style: { width: 400, height: 300 },
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
    data: { label: label || "Group" } as GroupNodeData,
    style: { width: size.width, height: size.height },
    className: "react-flow__node-group",
  };
}

export function duplicateNode(
  node: AnyNode,
  offset: { x: number; y: number }
): AnyNode {
  return {
    ...JSON.parse(JSON.stringify(node)),
    id: uid(node.type || "copy"),
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
