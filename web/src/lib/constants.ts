/**
 * 全局常量集中定义。
 * 包含节点类型枚举、资产分类等运行时常量，视口与缩放默认值、
 * 历史栈上限、各类节点默认 / 最小尺寸、布局间距以及自定义事件名 EventNames。
 *
 * 注意：本文件承载所有「运行时常量 / 函数」，类型定义请放在 lib/types/*。
 */
import type { AssetType } from "./types/assets";
import type {
  BackgroundType,
  ThemeMode,
  ViewportState,
} from "./types/canvas";
import type {
  TaskBinding,
  UploadState,
} from "./types/nodes";

// Viewport
export const DEFAULT_VIEWPORT: ViewportState = { x: 0, y: 0, zoom: 1 };
export const DEFAULT_BACKGROUND: BackgroundType = "dots";
export const DEFAULT_THEME: ThemeMode = "dark";
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
// History
export const HISTORY_MAX_SIZE = 50;

// Node sizing
export const DEFAULT_NODE_WIDTH = 600;
export const DEFAULT_NODE_HEIGHT = 338; // 16:9

// 节点标题栏统一高度（px），所有节点共用，避免内联写死
export const NODE_TITLE_HEIGHT = 28;
// 输入/输出连接点垂直原点：去掉标题栏高度后内容区正中
// 内容区中心相对节点顶部 = 总高/2 + 标题栏/2，故 top = 50% + NODE_TITLE_HEIGHT/2
export const NODE_HANDLE_TOP = `calc(50% + ${NODE_TITLE_HEIGHT / 2}px)`;
export const TEXT_NODE_DEFAULT_WIDTH = 350;
export const TEXT_NODE_DEFAULT_HEIGHT = 400;
export const TEXT_NODE_MIN_WIDTH = 350;
export const TEXT_NODE_MIN_HEIGHT = 400;

export const DIRECTOR_NODE_DEFAULT_WIDTH = 350;
export const DIRECTOR_NODE_DEFAULT_HEIGHT = 400;

// Copy/paste offset
export const PASTE_OFFSET = { x: 30, y: 30 };

// Group node
export const GROUP_NODE_PADDING = 40;
export const GROUP_NODE_MIN_WIDTH = 200;
export const GROUP_NODE_MIN_HEIGHT = 120;

// Audio node (fixed size, ~0.7x of image default, no resize)
export const AUDIO_NODE_WIDTH = 420;
export const AUDIO_NODE_HEIGHT = 237;

// Image/video thumbnail display (short side max pixels)
/** 节点显示尺寸上限（长边约束，px） */
export const NODE_DISPLAY_MAX = 600;

// ── 节点类型枚举（自 lib/types/canvas.ts 迁移，types 目录应保持纯类型） ──
export const NODE_TYPE = {
  TEXT: "text-node",
  IMAGE: "image-node",
  VIDEO: "video-node",
  AUDIO: "audio-node",
  DIRECTOR: "director-node",
  GROUP: "group-node",
} as const;

// ── 资产分类（自 lib/types/assets.ts 迁移） ──
export const ASSET_CATEGORIES: { key: AssetType | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "asset.cat.all" },
  { key: "character", labelKey: "asset.cat.character" },
  { key: "scene", labelKey: "asset.cat.scene" },
  { key: "object", labelKey: "asset.cat.object" },
  { key: "style", labelKey: "asset.cat.style" },
  { key: "audio", labelKey: "asset.cat.audio" },
  { key: "other", labelKey: "asset.cat.other" },
];

/** 虚拟「未分类」文件夹的 ID：代表 folder_id 为 NULL 的资产集合（不落库） */
export const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";

// ── 任务绑定 / 上传状态常量（自 lib/types/nodes.ts 迁移） ──
export const TASK_BINDING_KEY = "taskBinding" as const;

/** 已完成/无任务的空绑定 */
export const EMPTY_TASK_BINDING: TaskBinding = { taskId: "", status: "completed" };

/** 是否处于生成/处理中——由 taskBinding.status 推导，不再有独立 generating 字段 */
export function isGenerating(binding: TaskBinding | undefined): boolean {
  return binding?.status === "pending" || binding?.status === "processing";
}

export const UPLOAD_KEY = "upload" as const;

/** 初始上传状态 */
export const EMPTY_UPLOAD_STATE: UploadState = { uploading: false, progress: undefined, version: 0 };

// ── Node colors（原 node-colors.ts，合并至此） ──
// 节点类型对应的语义色，用于小地图 minimap 节点着色。
// 各节点的 input/output handle 小圆点颜色以节点组件内写死的实际显示色为准，
// 此处与之保持一致，保证小地图与画布上节点圆点颜色对齐。
export const NODE_TYPE_COLOR: Record<string, string> = {
  [NODE_TYPE.TEXT]: "#1677ff",
  [NODE_TYPE.IMAGE]: "#52c41a",
  [NODE_TYPE.VIDEO]: "#13c2c2",
  [NODE_TYPE.AUDIO]: "#fa8c16",
  [NODE_TYPE.GROUP]: "#722ed1",
  [NODE_TYPE.DIRECTOR]: "#722ed1",
};

export const DEFAULT_NODE_COLOR = "#1677ff";

export function getNodeColor(type: string | undefined): string {
  if (!type) return DEFAULT_NODE_COLOR;
  return NODE_TYPE_COLOR[type] ?? DEFAULT_NODE_COLOR;
}

// ── 画布自定义事件名（原 event-names.ts，合并至此） ──
// 组件间通过 window.dispatchEvent / addEventListener 使用这些事件通信，
// 统一管理避免字符串字面量散落各处。
export const EventNames = {
  /** 节点数据更新（data / style / 标记 dirty） */
  NODE_UPDATE_DATA: "node:update-data",
  /** 节点操作（来自 NodeToolbar，由节点组件处理） */
  CANVAS_NODE_ACTION: "canvas:node-action",
  /** 复制选中节点 */
  CANVAS_COPY_NODE: "canvas:copy-node",
  /** 删除节点 */
  CANVAS_DELETE_NODES: "canvas:delete-nodes",
  /** 删除边 */
  CANVAS_DELETE_EDGES: "canvas:delete-edges",
  /** 编组 */
  CANVAS_GROUP_NODES: "canvas:group-nodes",
  /** 取消编组 */
  CANVAS_UNGROUP_NODES: "canvas:ungroup-nodes",
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];
