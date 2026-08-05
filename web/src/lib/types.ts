/**
 * 类型定义统一导出口（barrel，纯类型）。
 *
 * 内部按领域拆分为独立文件，新增代码请直接从领域文件导入类型：
 *   import type { ImageNodeData } from "@/lib/types/nodes";
 *   import type { ModelInfo }    from "@/lib/types/models";
 *
 * 运行时常量（NODE_TYPE、ASSET_CATEGORIES、TASK_BINDING_KEY 等）与函数
 * （isGenerating）已迁移至 "@/lib/constants"，请勿从此处导入运行时值。
 *
 * 此文件保留向后兼容，已有代码的类型导入无需改动。
 */

export type {
  AnyEdge,
  BackgroundType,
  ThemeMode,
  ViewportState,
} from "./types/canvas";

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

export type {
  CanvasProject,
  HistorySnapshot,
  ClipboardData,
} from "./types/project";
