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
  AnyNode,
  AnyEdge,
  TextNode,
  ImageNode,
  VideoNode,
  AudioNode,
  DirectorNode,
  GroupNode,
  TextNodeData,
  ImageNodeData,
  VideoNodeData,
  AudioNodeData,
  GroupNodeData,
  DirectorNodeData,
  DirectorEntityState,
  DirectorStateData,
  GenSettings,
  VideoGenSettings,
  MediaGenFields,
  ViewportState,
  TaskBinding,
  TaskStatus,
  UploadState,
  BackgroundType,
  ThemeMode,
} from "./types";

// ── 节点工厂 ──
export {
  createTextNode,
  createImageNode,
  createVideoNode,
  createAudioNode,
  directorNode,
  createGroupNode,
  duplicateNode,
  createEdge,
} from "./node-defaults";

// ── 节点元信息 ──
export {
  NODE_TYPE_I18N,
  NODE_TYPE_ORDER,
  getNodeTypeColor,
  getNodeTypeIcon,
} from "./node-type-meta";

// ── Stores ──
export {
  useCanvasStore,
  markDirty,
  markDirtyImmediate,
  syncLiveViewport,
  getLiveViewport,
  flushAndWait,
  flushOnUnload,
  takeCanvasSnapshot,
  getViewportCenter,
  findFreePosition,
} from "./stores/canvas-store";
export { useHistoryStore } from "./stores/history-store";
export { useContextMenuStore } from "./stores/context-menu-store";
export { useSelectionStore } from "./stores/selection-store";

// ── Hooks ──
export { useCanvasEvents } from "./hooks/use-canvas-events";
export { useCanvasKeyboard } from "./hooks/use-canvas-keyboard";
export { useFileDrop } from "./hooks/use-file-drop";
export { useAddNode, type AddNodeType } from "./hooks/use-add-node";
export { useGroupOperations } from "./hooks/use-group-operations";
export { useEditableTitle } from "./hooks/use-editable-title";
export {
  computeAlignment,
  type AlignmentGuide,
  type AlignmentResult,
} from "./hooks/use-alignment-guides";
export { useVideoThumbnail } from "./hooks/use-video-thumbnail";

// ── API ──
export {
  generationApi,
  submitGenerationTask,
  cancelGenerationTask,
  streamGenerationTask,
  type SubmitGenerationTaskBody,
} from "./api/generation-api";
export { captureFrame } from "./api/file-api";
