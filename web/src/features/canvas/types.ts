/**
 * 画布类型定义（纯类型）。
 * 合并了画布基础类型（连线别名、背景/主题枚举、视口）与节点数据类型
 * （任务绑定、生成参数、各节点 data 结构、判别联合 AnyNode）。
 *
 * 运行时常量（NODE_TYPE、TASK_BINDING_KEY、UPLOAD_KEY 等）在 lib/constants.ts。
 */
import type { Edge, Node } from "@xyflow/react";

import type { NODE_TYPE } from "@/lib/constants";

// ============================================================
// Canvas 基础类型（画布状态、节点类型枚举）
// ============================================================

export type AnyEdge = Edge<Record<string, unknown>, string>;

export type BackgroundType = "dots" | "grid" | "blank";
export type ThemeMode = "light" | "dark";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

// ============================================================
// 任务绑定（生成 / 异步任务状态）
// ============================================================

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskBinding {
  /** 后端任务 ID（本地处理如裁剪/变换时为空串） */
  taskId: string;
  status: TaskStatus;
  /** 异步任务的语义动作 */
  pendingAction?: string;
}

// ============================================================
// 上传状态
// ============================================================

export interface UploadState {
  uploading: boolean;
  /** 上传进度 0-100 */
  progress?: number;
  /** 防竞态版本号：每次重新上传自增，回调按版本号丢弃过期结果 */
  version: number;
}

// ============================================================
// 生成面板设置（持久化到节点）
// ============================================================

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
  refAudioOrder: string[];
  n: number;
}

/** 图片/视频节点共享的生成相关子字段 */
export interface MediaGenFields {
  taskBinding?: TaskBinding;
  upload?: UploadState;
  genSettings?: GenSettings | VideoGenSettings;
}

// ============================================================
// 节点 data 类型
// ============================================================

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
  /** 内容来源：upload = 用户上传/资产库添加（素材），generate = AI 生成 */
  source?: "upload" | "generate";
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

export type AudioNodeData = {
  /** 展示标题（双写 alt，见 ImageNode 约定） */
  label: string;
  /** 音频资源地址（复用 src 字段名以继承 save-manager 哈希收集） */
  src: string;
  /** 回退标题 */
  alt: string;
  /** 音频时长（秒），加载元数据后回填 */
  duration?: number;
  taskBinding?: TaskBinding;
  upload?: UploadState;
};

export type GroupNodeData = {
  label: string;
};

// ============================================================
// Director 节点 data
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
export type AudioNode = Node<AudioNodeData, typeof NODE_TYPE.AUDIO>;
export type DirectorNode = Node<DirectorNodeData, typeof NODE_TYPE.DIRECTOR>;
export type GroupNode = Node<GroupNodeData, typeof NODE_TYPE.GROUP>;

export type AnyNode = TextNode | ImageNode | VideoNode | AudioNode | DirectorNode | GroupNode;
