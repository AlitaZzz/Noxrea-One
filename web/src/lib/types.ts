/**
 * 类型定义统一导出口（barrel）。
 *
 * 内部按领域拆分为独立文件，新增代码请直接从领域文件导入：
 *   import type { ImageNodeData } from "@/lib/types/nodes";
 *   import type { ModelInfo }    from "@/lib/types/models";
 *
 * 此文件保留向后兼容，已有代码无需改动。
 */

export type {
  AnyEdge,
  BackgroundType,
  ThemeMode,
  ViewportState,
} from "./types/canvas";

export { NODE_TYPE } from "./types/canvas";

export type {
  TaskStatus,
  TaskBinding,
  UploadState,
  GenSettings,
  VideoGenSettings,
  MediaGenFields,
  TextNodeData,
  ImageNodeData,
  VideoNodeData,
  AudioNodeData,
  GroupNodeData,
  DirectorEntityState,
  DirectorStateData,
  DirectorNodeData,
  TextNode,
  ImageNode,
  VideoNode,
  AudioNode,
  DirectorNode,
  GroupNode,
  AnyNode,
} from "./types/nodes";

export {
  TASK_BINDING_KEY,
  EMPTY_TASK_BINDING,
  isGenerating,
  UPLOAD_KEY,
  EMPTY_UPLOAD_STATE,
} from "./types/nodes";

export type {
  ModelCapability,
  ProviderPreset,
  ModelParamConfig,
  ModelInfo,
  ModelChannel,
} from "./types/models";

export type {
  AssetType,
  AssetFolder,
  MediaType,
  AssetItem,
  CreateAssetInput,
} from "./types/assets";

export {
  ASSET_CATEGORIES,
  UNCATEGORIZED_FOLDER_ID,
} from "./types/assets";

export type {
  CanvasProject,
  HistorySnapshot,
  ClipboardData,
} from "./types/project";
