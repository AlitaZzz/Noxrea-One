import type { NodeTypes } from "@xyflow/react";

import AudioNode from "@/features/canvas/nodes/AudioNode";
import DirectorNode from "@/features/canvas/nodes/DirectorNode";
import GroupNode from "@/features/canvas/nodes/GroupNode";
import ImageNode from "@/features/canvas/nodes/ImageNode";
import TextNode from "@/features/canvas/nodes/TextNode";
import VideoNode from "@/features/canvas/nodes/VideoNode";
import { memoCanvasNode } from "@/features/canvas/shared/memo-canvas-node";
import { NODE_TYPE } from "@/lib/constants";

/**
 * React Flow 节点类型注册表。
 *
 * 这是 React Flow 向节点组件注入 props 的唯一契约点：所有节点组件统一经
 * memoCanvasNode 包装，位置类 props 不触达节点子树（原因见该模块注释）。
 * 新增节点类型必须登记在这里，渲染边界随之生效。
 *
 * nodeTypes 必须是稳定引用（组件外常量），否则 React Flow 会反复重建节点。
 */
export const CANVAS_NODE_TYPES = {
  [NODE_TYPE.TEXT]: memoCanvasNode(TextNode),
  [NODE_TYPE.IMAGE]: memoCanvasNode(ImageNode),
  [NODE_TYPE.VIDEO]: memoCanvasNode(VideoNode),
  [NODE_TYPE.AUDIO]: memoCanvasNode(AudioNode),
  [NODE_TYPE.GROUP]: memoCanvasNode(GroupNode),
  [NODE_TYPE.DIRECTOR]: memoCanvasNode(DirectorNode),
} satisfies NodeTypes;
