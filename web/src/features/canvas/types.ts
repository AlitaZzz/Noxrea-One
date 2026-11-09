/**
 * 画布类型定义（纯类型）。
 * 只承载 feature 内部的节点数据类型（生成参数、各节点 data 结构、判别联合 AnyNode）；
 * 画布基础类型（视口 / 任务绑定 / 上传状态）的归属是 `@/lib/types/canvas`，
 * 需要时直接从那里导入，不在本文件转出。
 *
 * 运行时常量（NODE_TYPE、UPLOAD_KEY 等）在 lib/constants.ts。
 */
import type { Edge, Node } from "@xyflow/react";

import type { DirectorStateData } from "@/entities/director";
import type { ProjectSummary } from "@/entities/project";
import type { NODE_TYPE } from "@/lib/constants";
import type { TaskBinding, UploadState, ViewportState } from "@/lib/types/canvas";

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
 * data 层不携带归属字段。
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
  /** 多图结果：所有结果图的存储 key 列表（值域同 src：key 或外部 URL）。存在且长度>=2 时，节点以「堆叠卡片/展开网格」模式展示 */
  multiResultKeys?: string[];
  /** 多图结果：生成总张数（用于角标，缺省回退到 multiResultKeys.length） */
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

// ============================================================
// 画布文档（项目内容与编辑会话）
// ============================================================

/**
 * 单项目全量投影：项目摘要 + 画布内容。
 * 唯一来源是 SSE 握手首帧下发的服务端快照（useCanvasSession 采纳）；
 * 项目列表（`entities/project`）不持有内容。
 */
export interface CanvasProject extends ProjectSummary {
  viewport: ViewportState;
  minimapVisible?: boolean;
  snapEnabled?: boolean;
  agentModel?: string;
  nodes: AnyNode[];
  edges: AnyEdge[];
}

/**
 * 提交服务端的画布内容快照。
 * 与 CanvasProject 的区别：不含服务端拥有的元数据（id/name/revision/updatedAt），
 * 只包含画布自身状态。
 */
export interface CanvasData {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  minimapVisible: boolean;
  snapEnabled: boolean;
  agentModel?: string;
}

export interface CanvasDataDelta {
  nodes: { upsert: AnyNode[]; delete: string[] };
  edges: { upsert: AnyEdge[]; delete: string[] };
  viewport?: ViewportState;
  minimapVisible?: boolean;
  snapEnabled?: boolean;
  agentModel?: string | null;
}

/** undo/redo 历史快照。 */
export interface HistorySnapshot {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  minimapVisible: boolean;
  snapEnabled: boolean;
}

/** 画布内复制/粘贴的节点与连线集合。 */
export interface ClipboardData {
  nodes: AnyNode[];
  edges: AnyEdge[];
}
