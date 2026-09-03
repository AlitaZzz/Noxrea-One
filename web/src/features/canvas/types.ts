/**
 * 画布类型定义（纯类型）。
 * 合并了画布基础类型（连线别名、背景/主题枚举、视口）与节点数据类型
 * （任务绑定、生成参数、各节点 data 结构、判别联合 AnyNode）。
 *
 * 运行时常量（NODE_TYPE、TASK_BINDING_KEY、UPLOAD_KEY 等）在 lib/constants.ts。
 */
import type { Edge, Node } from "@xyflow/react";

import type { NODE_TYPE } from "@/lib/constants";
import type { UploadErrorInfo } from "@/lib/utils/upload";

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
  /** 任务开始时间戳（ms），用于生成中遮罩显示实时耗时 */
  startedAt?: number;
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
  /** 上传期间的本地预览 URL（blob:或 data:），用于模糊背景渲染 */
  previewUrl?: string;
  /**
   * 失败态信息：存在且 uploading 为 false 时，节点渲染失败遮罩与重试 / 移除入口。
   * 失败节点会留在画布上（不自动删除），避免裁剪 / 标注等加工产物白做。
   */
  error?: UploadErrorInfo;
}

// ============================================================
// 生成面板设置（持久化到节点）
// ============================================================

/** 各生成类型共享的基础字段 */
interface BaseGenSettings {
  /** 判别字段：标识生成类型 */
  kind: string;
  prompt: string;
  modelKey: string;
  refOrder: string[];
}

/** 文本生成设置 */
export interface TextGenSettings extends BaseGenSettings {
  kind: "text";
}

/** 图片生成设置 */
export interface ImageGenSettings extends BaseGenSettings {
  kind: "image";
  quality: string;
  resolution: string;
  ratio: string;
  n: number;
}

/** 视频生成设置 */
export interface VideoGenSettings extends BaseGenSettings {
  kind: "video";
  resolution: string;
  ratio: string;
  seconds: number;
  generateAudio: boolean;
  refAudioOrder: string[];
  /** 参考视频顺序（上游 VIDEO 节点 src） */
  refVideoOrder: string[];
  /** 参考方式：none/first/first-last/full，空或 none = 文生视频 */
  refMode?: string;
  n: number;
}

/** 语音生成设置 */
export interface AudioGenSettings extends BaseGenSettings {
  kind: "audio";
}

/** 生成设置判别联合：文本 / 图片 / 视频 / 语音 */
export type GenSettings = TextGenSettings | ImageGenSettings | VideoGenSettings | AudioGenSettings;

/** 图片/视频节点共享的生成相关子字段 */
export interface MediaGenFields {
  taskBinding?: TaskBinding;
  upload?: UploadState;
  genSettings?: GenSettings;
}

// ============================================================
// 节点 data 类型
// ============================================================

/**
 * 逻辑分组字段：节点始终使用绝对坐标，组仅通过 groupId 标记归属，
 * 不再依赖 React Flow 的 parentId / 相对坐标嵌套。
 */
export interface GroupableData {
  /** 所属组的节点 id；未分组时为 undefined */
  groupId?: string;
  [key: string]: unknown;
}

export type TextNodeData = GroupableData & {
  label: string;
  content: string; // 富文本 HTML，仅供编辑器渲染
  plainText: string; // 纯文本，仅供下游消费
  genSettings?: TextGenSettings;
  taskBinding?: TaskBinding;
};

// 注意：node data 采用扁平 type 别名（而非与 interface 交叉），
// 以获得隐式索引签名，满足 React Flow 基础 Node 的 Record<string, unknown> 约束。
export type ImageNodeData = GroupableData & {
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
  genSettings?: ImageGenSettings;
  /** 多图结果：所有结果图的 URL 列表（children）。存在且长度>=2 时，节点以「堆叠卡片/展开网格」模式展示 */
  multiResultUrls?: string[];
  /** 多图结果：生成总张数（用于角标，缺省回退到 multiResultUrls.length） */
  multiResultTotalCount?: number;
  /** 内容来源：upload = 用户上传/资产库添加（素材），generate = AI 生成，derived = 从已有图片派生（裁剪/切分/标注等） */
  source?: "upload" | "generate" | "derived";
  /** 全景模式：为 true 时该节点进入全景模式渲染，false/缺省时普通模式（随节点 data 落库） */
  panorama?: boolean;
};

export type VideoNodeData = GroupableData & {
  label: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
  taskBinding?: TaskBinding;
  upload?: UploadState;
  genSettings?: VideoGenSettings;
  /** 内容来源：upload = 用户上传/资产库添加（素材），generate = AI 生成，derived = 从已有资源派生 */
  source?: "upload" | "generate" | "derived";
  /**
   * 是否含音轨。由节点探测后回填（skipHistory，不进撤销栈）：
   * true = 有音轨；false = 确定无音轨（工具栏禁用分离）；undefined = 尚未探测出结论。
   */
  hasAudio?: boolean;
};

export type AudioNodeData = GroupableData & {
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
  /** 分组配色 key（对应 GroupColorKey），未设置时使用默认灰白色 */
  color?: string;
};

// 组节点自身不参与分组（不会成为别的组的成员），保持独立 data 形状。

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

export type DirectorNodeData = GroupableData & {
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
