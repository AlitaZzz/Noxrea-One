import type { Edge, Node } from "@xyflow/react";

export type AnyEdge = Edge<Record<string, unknown>, string>;

// ============================================================
// Canvas state types
// ============================================================

export type BackgroundType = "dots" | "grid" | "blank";
export type ThemeMode = "light" | "dark";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

// ============================================================
// Node data types
// ============================================================

export const NODE_TYPE = {
  TEXT: "text-node",
  IMAGE: "image-node",
  VIDEO: "video-node",
  DIRECTOR: "director-node",
  GROUP: "group-node",
} as const;

// ── 任务绑定（生成 / 异步任务状态）────────────────────
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskBinding {
  /** 后端任务 ID（本地处理如裁剪/变换时为空串） */
  taskId: string;
  status: TaskStatus;
  /** 异步任务的语义动作，如 "bg_removal" */
  pendingAction?: string;
}

export const TASK_BINDING_KEY = "taskBinding" as const;

/** 已完成/无任务的空绑定 */
export const EMPTY_TASK_BINDING: TaskBinding = { taskId: "", status: "completed" };

/** 是否处于生成/处理中——由 taskBinding.status 推导，不再有独立 generating 字段 */
export function isGenerating(binding: TaskBinding | undefined): boolean {
  return binding?.status === "pending" || binding?.status === "processing";
}

// ── 上传状态 ──────────────────────────────────────────
export interface UploadState {
  uploading: boolean;
  /** 上传进度 0-100 */
  progress?: number;
  /** 防竞态版本号：每次重新上传自增，回调按版本号丢弃过期结果 */
  version: number;
}

export const UPLOAD_KEY = "upload" as const;

/** 初始上传状态 */
export const EMPTY_UPLOAD_STATE: UploadState = { uploading: false, progress: undefined, version: 0 };

// ── 生成面板设置（持久化到节点）────────────────────────
export interface GenSettings {
  prompt: string;
  modelKey: string;
  quality: string;
  resolution: string;
  ratio: string;
  refOrder: string[];
  n: number;
}

/** 视频生成面板设置 */
export interface VideoGenSettings {
  prompt: string;
  modelKey: string;
  resolution: string;
  ratio: string;
  seconds: number;
  generateAudio: boolean;
  refOrder: string[];
  n: number;
}

/** 图片/视频节点共享的生成相关子字段 */
export interface MediaGenFields {
  taskBinding?: TaskBinding;
  upload?: UploadState;
  genSettings?: GenSettings | VideoGenSettings;
}

export type TextNodeData = {
  label: string;
  content: string;
  genSettings?: GenSettings;
  taskBinding?: TaskBinding;
};

// 注意：node data 采用扁平 type 别名（而非与 interface 交叉），
// 以获得隐式索引签名，满足 React Flow 基础 Node 的 Record<string, unknown> 约束。
export type ImageNodeData = {
  label: string;
  src: string;
  lockAspectRatio: boolean;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
  /** CSS 旋转度数（0/90/180/270），仅影响显示，不修改原图文件 */
  rotation?: number;
  /** CSS 水平翻转，仅影响显示，不修改原图文件 */
  flipH?: boolean;
  /** CSS 垂直翻转，仅影响显示，不修改原图文件 */
  flipV?: boolean;
  taskBinding?: TaskBinding;
  upload?: UploadState;
  genSettings?: GenSettings;
  /** 多图结果：所有结果图的 URL 列表（children）。存在且长度>=2 时，节点以「堆叠卡片/展开网格」模式展示 */
  multiResultUrls?: string[];
  /** 多图结果：生成总张数（用于角标，缺省回退到 multiResultUrls.length） */
  multiResultTotalCount?: number;
};

export type VideoNodeData = {
  label: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
  taskBinding?: TaskBinding;
  upload?: UploadState;
  genSettings?: VideoGenSettings;
};

// ============================================================
// Model configuration
// ============================================================

export type ModelCapability = "text" | "image" | "video" | "audio";

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  protocol?: string;
  config?: Record<string, unknown>;
}

export interface ModelParamConfig {
  params: string[];
  defaults: Record<string, unknown>;
  constraints: Record<string, string[]>;
}

/** 模型信息（与 API 契约一致，camelCase） */
export interface ModelInfo {
  id: string;
  name: string;
  channelId?: string;
  capabilities: ModelCapability[];
  // 拉取时推断出的类型（如 image/video），仅作展示提示，不自动勾选进「已启用」
  inferredCapabilities?: ModelCapability[];
}

/** 渠道信息（与 API 契约一致，camelCase） */
export interface ModelChannel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: string;
  config?: Record<string, unknown>;
  models: ModelInfo[];
}

export type GroupNodeData = {
  label: string;
};

// ============================================================
// Director node
// ============================================================

export interface DirectorEntityState {
  id: string;
  type: "character" | "prop" | "camera" | "crowd";
  name: string;
  visible: boolean;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
  // Character
  bodyType?: string;
  color?: string;
  srcUrl?: string;
  pose?: { mode: "preset" | "manual"; preset?: string | null; values?: Record<string, number> };
  // Prop
  kind?: string;
  // Camera
  fov?: number;
  roll?: number;
  // Crowd
  rows?: number;
  cols?: number;
  spacing?: number;
  members?: Omit<DirectorEntityState, "rows" | "cols" | "spacing" | "members">[];
}

export interface DirectorStateData {
  entities: DirectorEntityState[];
  sceneState: Record<string, unknown>;
  ratio: string;
  cameraView: boolean;
  transformMode: string;
  shots: Array<{
    id: string;
    url: string;
    name: string;
    cameraId: string;
    createdAt: number;
    selected?: boolean;
  }>;
}

export type DirectorNodeData = {
  label: string;
  directorState?: DirectorStateData;
};

// ============================================================
// 判别联合节点类型（discriminator = type 字段）
// ============================================================

export type TextNode = Node<TextNodeData, typeof NODE_TYPE.TEXT>;
export type ImageNode = Node<ImageNodeData, typeof NODE_TYPE.IMAGE>;
export type VideoNode = Node<VideoNodeData, typeof NODE_TYPE.VIDEO>;
export type DirectorNode = Node<DirectorNodeData, typeof NODE_TYPE.DIRECTOR>;
export type GroupNode = Node<GroupNodeData, typeof NODE_TYPE.GROUP>;

export type AnyNode = TextNode | ImageNode | VideoNode | DirectorNode | GroupNode;

// ============================================================
// My Assets
// ============================================================

export type AssetType = "character" | "scene" | "object" | "style" | "audio" | "other";

export const ASSET_CATEGORIES: { key: AssetType | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "asset.cat.all" },
  { key: "character", labelKey: "asset.cat.character" },
  { key: "scene", labelKey: "asset.cat.scene" },
  { key: "object", labelKey: "asset.cat.object" },
  { key: "style", labelKey: "asset.cat.style" },
  { key: "audio", labelKey: "asset.cat.audio" },
  { key: "other", labelKey: "asset.cat.other" },
];

export interface AssetFolder {
  id: string;
  name: string;
  spaceKey: string;
  parentId?: string;
  createdAt: number;
  count: number;
}

/** 虚拟「未分类」文件夹的 ID：代表 folder_id 为 NULL 的资产集合（不落库） */
export const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";

export interface AssetItem {
  id: string;
  name: string;
  type: AssetType;
  width: number;
  height: number;
  description: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  metadata: Record<string, unknown>;
  folderId?: string;
  spaceKey: string;
}

export interface CreateAssetInput {
  name: string;
  type: AssetType;
  width?: number;
  height?: number;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  folderId?: string;
  spaceKey?: string;
}

// ============================================================
// Project
// ============================================================

export interface CanvasProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  viewport: ViewportState;
  background: BackgroundType;
  theme: ThemeMode;
  minimapVisible?: boolean;
  snapToGrid?: boolean;
  nodes: AnyNode[];
  edges: AnyEdge[];
}

// ============================================================
// History (undo/redo)
// ============================================================

export interface HistorySnapshot {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  background: BackgroundType;
  theme: ThemeMode;
  minimapVisible: boolean;
  snapToGrid: boolean;
}

// ============================================================
// Clipboard
// ============================================================

export interface ClipboardData {
  nodes: AnyNode[];
  edges: AnyEdge[];
}
