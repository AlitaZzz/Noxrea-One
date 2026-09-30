/**
 * 画布类型定义（纯类型）。
 * 合并了画布基础类型（连线别名、背景/主题枚举、视口）与节点数据类型
 * （任务绑定、生成参数、各节点 data 结构、判别联合 AnyNode）。
 *
 * 运行时常量（NODE_TYPE、UPLOAD_KEY 等）在 lib/constants.ts。
 */
import type { Edge, Node } from "@xyflow/react";

import type { SceneState } from "@/features/director/types";
import type { NODE_TYPE } from "@/lib/constants";
import type { TaskBinding, UploadState } from "@/lib/types/canvas";

// 画布基础类型（背景 / 主题 / 视口 / 任务绑定 / 上传状态）下沉至 lib/types/canvas，
// 使 lib/constants.ts 等底层模块可以引用而不反向依赖 feature 层。
// 此处统一转出，保证上层 "@/features/canvas/types" 的既有导入路径不变。
export type {
  BackgroundType,
  TaskBinding,
  TaskStatus,
  UploadState,
  ViewportState,
} from "@/lib/types/canvas";

// ============================================================
// Canvas 基础类型（画布状态、节点类型枚举）
// ============================================================

export type AnyEdge = Edge<Record<string, unknown>, string>;

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
  /** 参考音频顺序（上游 AUDIO 节点 src），仅持久化排序偏好 */
  refAudioOrder?: string[];
  /** 参考视频顺序（上游 VIDEO 节点 src），仅持久化排序偏好 */
  refVideoOrder?: string[];
}

/** 图片生成设置 */
export interface ImageGenSettings extends BaseGenSettings {
  kind: "image";
  /** 参数字段只持久化用户实际设置过的值；未设置时由面板回退到当前模型默认值 */
  quality?: string;
  resolution?: string;
  ratio?: string;
  n?: number;
}

/** 视频生成设置 */
export interface VideoGenSettings extends BaseGenSettings {
  kind: "video";
  resolution?: string;
  ratio?: string;
  seconds?: number;
  generateAudio?: boolean;
  refAudioOrder: string[];
  /** 参考视频顺序（上游 VIDEO 节点 src） */
  refVideoOrder: string[];
  /** 参考方式：none/first/first-last/full，空或 none = 文生视频 */
  refMode?: string;
  n?: number;
}

/** 生成设置判别联合：文本 / 图片 / 视频（音频生成未开放，仅保留节点形态） */
export type GenSettings = TextGenSettings | ImageGenSettings | VideoGenSettings;

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
 * 分组采用 React Flow 官方 Sub Flow 模型：父子关系由节点顶层字段
 * `parentId` 表达（唯一结构关系），子节点 position 为组内相对坐标。
 * data 层不再携带任何归属字段（旧数据在 restoreFromProject 入口由
 * migrateCanvasNodes 一次性迁移）。
 */
export type TextNodeData = {
  /** 展示标题。文本无资源文件名语义（导出文件名直接用 label），故不设 alt 字段 */
  label: string;
  content: string; // 富文本 HTML，仅供编辑器渲染
  plainText: string; // 纯文本，仅供下游消费
  /** 节点创建时间戳（ms），资源管理器等列表展示用 */
  createdAt?: number;
  genSettings?: TextGenSettings;
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
  /** 节点创建时间戳（ms），资源管理器等列表展示用 */
  createdAt?: number;
  /** 源文件大小（字节），上传/生成落库时回填，资源管理器展示用 */
  fileSize?: number;
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
  /** 待尺寸校正：资产记录缺宽高（入库时探针失败等历史坏数据存了 0）时由插入层置位，
      值为落位时的初始节点尺寸。ImageNode 主图加载完成后按图片真实宽高校正比例并清除；
      用户已手动改过尺寸（style 与记录不符）则只清标记。正常资产不会有此标记 */
  pendingNaturalSize?: { width: number; height: number };
};

export type VideoNodeData = {
  label: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** 视频时长（秒），节点加载元数据后回填（skipHistory），资源管理器等列表展示用 */
  duration?: number;
  /** 节点创建时间戳（ms），资源管理器等列表展示用 */
  createdAt?: number;
  /** 源文件大小（字节），上传/生成落库时回填，资源管理器展示用 */
  fileSize?: number;
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

export type AudioNodeData = {
  /** 展示标题 */
  label: string;
  /** 音频资源地址（复用 src 字段名以继承 save-manager 哈希收集） */
  src: string;
  /** 音频时长（秒），加载元数据后回填 */
  duration?: number;
  /** 节点创建时间戳（ms），资源管理器等列表展示用 */
  createdAt?: number;
  /** 源文件大小（字节），上传/生成落库时回填，资源管理器展示用 */
  fileSize?: number;
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
  sceneState: Partial<SceneState>;
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
  /** 节点创建时间戳（ms），资源管理器等列表展示用 */
  createdAt?: number;
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
