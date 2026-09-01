/**
 * 统一上传管道的类型定义。
 *
 * 画布上所有「素材上云」入口（拖入画布、节点内替换、生成面板参考区、
 * 裁剪 / 宫格切分 / 标注等加工产物、全景截图、导演截图、资产库上传）
 * 共用同一条管道：调用方只描述「待上传数据」与「落库策略（sink）」，
 * 管道负责探测尺寸、建占位、并发上传、进度回写、成功落库与失败回滚。
 */
import type { UploadResult } from "@/lib/utils/upload";

/** 媒体类型：决定创建哪种画布节点 */
export type MediaKind = "image" | "video" | "audio";

/** 单个待上传产物 */
export interface UploadItem {
  /** 待上传数据。File 本身就是 Blob，加工产物（canvas 导出）直接传 Blob */
  blob: Blob;
  /** 上传文件名（Blob 无名称时必填） */
  filename: string;
  /** 目标节点类型；缺省按 blob.type / 扩展名推断 */
  nodeType?: MediaKind;
  /** 已知自然尺寸。提供后管道跳过本地探测（加工产物应提供） */
  naturalWidth?: number;
  naturalHeight?: number;
  /** 调用方已创建的本地预览 URL；传入后由管道负责释放 */
  previewUrl?: string;
  /** 节点标题（完整覆盖）。不传时用 filename */
  label?: string;
  /** 节点标题后缀（派生节点用：原名 + 后缀 + 扩展名）。label 优先 */
  labelSuffix?: string;
  /** 落位。不传时由 sink 决定（create 缺省 (0,0)，derived 缺省源节点右侧，anchor 缺省锚点旁） */
  position?: { x: number; y: number };
  /** 额外写入 node.data 的字段 */
  extraData?: Record<string, unknown>;
}

/**
 * 新建节点时的落位锚点：新节点贴在锚点节点的左侧或右侧，多个依次排开。
 * 用于生成面板参考区这类「围绕目标节点摆放」的场景。
 */
export interface UploadAnchor {
  nodeId: string;
  /** 放在锚点节点的左侧还是右侧 */
  side: "left" | "right";
  /** 与锚点节点的间隙（px） */
  gap: number;
}

/** 上传产物的落库策略 */
export type UploadSink =
  /** 新建节点（拖入画布、参考区上传）。connectTo 存在时自动连线 */
  | {
      kind: "create-node";
      connectTo?: string;
      /** out = 新节点作为连线起点（参考区：新节点 feeding 目标）；in = 新节点作为终点 */
      connectDir?: "in" | "out";
      anchor?: UploadAnchor;
    }
  /** 原地替换已有节点的内容（节点内上传） */
  | { kind: "replace-node"; nodeId: string; clearFields?: readonly string[] }
  /** 从已有节点加工派生的新节点（裁剪 / 宫格 / 标注 / 截图 / 翻转） */
  | { kind: "derived-node"; sourceId: string; connect?: boolean }
  /** 只上传拿 URL，不碰画布（资产库、头像） */
  | { kind: "raw" };

export interface UploadPlan {
  items: UploadItem[];
  sink: UploadSink;
  /** 文件归属：upload = 原始素材，derived = 画布加工产物。缺省按 sink 推断 */
  source?: "upload" | "derived";
  /** 并发数，默认 UPLOAD_CONCURRENCY */
  concurrency?: number;
  /** 为 true 时管道不弹任何提示，由调用方自行处理 */
  silent?: boolean;
  /** 单文件进度回调（index 对应 plan.items 下标） */
  onProgress?: (index: number, pct: number) => void;
}

export interface UploadSummary {
  succeeded: number;
  failed: number;
  /** 首个失败原因（服务端错误详情，已本地化） */
  reason?: string;
  /** 与 plan.items 顺序一致（被过滤掉的不支持文件为 undefined），失败项为 null */
  results: Array<UploadResult | null | undefined>;
}

export interface UploadHandle {
  /** 立即上画布的占位节点 ID（乐观 UI）；raw sink 为空数组 */
  nodeIds: string[];
  /** 全部上传结束后的汇总 */
  settled: Promise<UploadSummary>;
}
