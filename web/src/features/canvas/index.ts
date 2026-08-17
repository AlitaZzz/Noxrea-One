/**
 * Canvas feature 公开 API barrel。
 *
 * 消费方统一从 "@/features/canvas" 导入，
 * 避免直接引用内部文件路径。
 */

// ── 主组件 ──
export { default as InfiniteCanvas } from "./InfiniteCanvas";

// ── 类型 ──
export type {
  AnyEdge,
  AnyNode,
  AudioGenSettings,
  AudioNode,
  AudioNodeData,
  BackgroundType,
  DirectorEntityState,
  DirectorNode,
  DirectorNodeData,
  DirectorStateData,
  GenSettings,
  GroupNode,
  GroupNodeData,
  ImageGenSettings,
  ImageNode,
  ImageNodeData,
  MediaGenFields,
  TaskBinding,
  TaskStatus,
  TextGenSettings,
  TextNode,
  TextNodeData,
  ThemeMode,
  UploadState,
  VideoGenSettings,
  VideoNode,
  VideoNodeData,
  ViewportState,
} from "./types";

// ── 节点工厂 ──
export {
  createAudioNode,
  createEdge,
  createGroupNode,
  createImageNode,
  createTextNode,
  createVideoNode,
  directorNode,
  duplicateNode,
} from "./node-defaults";

// ── 节点元信息 ──
export {
  getNodeTypeColor,
  getNodeTypeIcon,
  NODE_TYPE_I18N,
  NODE_TYPE_ORDER,
} from "./NodeTypeMeta";

// ── Stores ──
export {
  findFreePosition,
  flushAndWait,
  flushOnUnload,
  getLiveViewport,
  getViewportCenter,
  markDirty,
  markDirtyImmediate,
  syncLiveViewport,
  takeCanvasSnapshot,
  useCanvasStore,
} from "./stores/canvas-store";
export { useContextMenuStore } from "./stores/context-menu-store";
export { useHistoryStore } from "./stores/history-store";
export { useSelectionStore } from "./stores/selection-store";

// ── Hooks ──
export { type AddNodeType,useAddNode } from "./hooks/use-add-node";
export {
  type AlignmentGuide,
  type AlignmentResult,
  computeAlignment,
} from "./hooks/use-alignment-guides";
export { useCanvasEvents } from "./hooks/use-canvas-events";
export { useCanvasKeyboard } from "./hooks/use-canvas-keyboard";
export { useEditableTitle } from "./hooks/use-editable-title";
export { useFileDrop } from "./hooks/use-file-drop";
export { useGroupOperations } from "./hooks/use-group-operations";
export { useVideoThumbnail } from "./hooks/use-video-thumbnail";

// ── API ──
export { captureFrame } from "./api/file-api";
export {
  cancelGenerationTask,
  generationApi,
  streamGenerationTask,
  submitGenerationTask,
  type SubmitGenerationTaskBody,
} from "./api/generation-api";
