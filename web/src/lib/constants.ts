/**
 * 全局常量集中定义。
 * 包含节点类型枚举、资产分类等运行时常量，视口与缩放默认值、
 * 历史栈上限、各类节点默认 / 最小尺寸、布局间距以及自定义事件名 EventNames。
 *
 * 注意：本文件承载所有「运行时常量 / 函数」，类型定义请放在 lib/types/*。
 */
// 这些纯类型下沉在 lib/types/*，避免 lib 层反向依赖 features（架构分层约束）
import type { AssetType } from "@/lib/types/assets";
import type {
  BackgroundType,
  ViewportState,
} from "@/lib/types/canvas";
import type {
  TaskBinding,
  UploadState,
} from "@/lib/types/canvas";

// Viewport
export const DEFAULT_VIEWPORT: ViewportState = { x: 0, y: 0, zoom: 1 };
export const DEFAULT_BACKGROUND: BackgroundType = "dots";
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

// Media seek margin
/** seek 精度容差（s）：末尾钳制（seekVideo / clipSeek / 抽帧）、循环入点判定
    共用同一值——循环判定容差必须 ≥ 末尾钳制余量，否则出点附近会来回折跳 */
export const SEEK_MARGIN_S = 0.05;

// History
export const HISTORY_MAX_SIZE = 50;

// Node sizing
/** 媒体节点默认宽度（px），同时是 16:9 内容区口径的基准长边 */
export const DEFAULT_NODE_WIDTH = 600;
/** 媒体节点默认内容区高度（px）：16:9（600 × 9/16 ≈ 338），不含标题栏。
 *  仅作媒体自然尺寸的兜底值（元数据加载失败时），不直接用作节点框高度 */
export const DEFAULT_NODE_CONTENT_HEIGHT = Math.round((DEFAULT_NODE_WIDTH * 9) / 16);
// 节点标题栏统一高度（px），所有节点共用，避免内联写死
export const NODE_TITLE_HEIGHT = 28;
/** 媒体节点默认整体高度（px）：内容区 + 标题栏，与 computeNodeSize 口径一致。
 *  创建空节点 / 清空回退 / 面板选比例 / 生成落地四处统一，避免节点尺寸跳变 */
export const DEFAULT_NODE_HEIGHT = DEFAULT_NODE_CONTENT_HEIGHT + NODE_TITLE_HEIGHT;

// 文本节点：无媒体内容区压缩问题，保持 16:9 内容区口径（不含标题栏补偿），不跟随媒体节点
export const TEXT_NODE_DEFAULT_WIDTH = DEFAULT_NODE_WIDTH;
export const TEXT_NODE_DEFAULT_HEIGHT = DEFAULT_NODE_CONTENT_HEIGHT;
export const TEXT_NODE_MIN_WIDTH = DEFAULT_NODE_WIDTH;
export const TEXT_NODE_MIN_HEIGHT = DEFAULT_NODE_CONTENT_HEIGHT;

export const DIRECTOR_NODE_DEFAULT_WIDTH = 350;
export const DIRECTOR_NODE_DEFAULT_HEIGHT = 400;

// Group node
export const GROUP_NODE_PADDING = 40;
export const GROUP_NODE_MIN_WIDTH = 200;
export const GROUP_NODE_MIN_HEIGHT = 120;

// 布局节点间距 & 磁吸边对边间距
export const LAYOUT_GAP = 60;

// 画布整理（tidy）
/** 单行目标宽度（px），超出即换行 */
export const TIDY_MAX_ROW_WIDTH = 1600;
/** 整理位移动画时长（ms） */
export const TIDY_ANIMATION_DURATION = 300;
/** 超过该节点数直接落位不播动画，避免每帧 setNodes 掉帧 */
export const TIDY_MAX_ANIMATED_NODES = 80;

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
// 节点类型对应的语义色，用于小地图 minimap 节点着色与类型图标着色。
// 取值属于「分类色板」：与青柠主题同屏和谐（明度接近、饱和度克制），
// 但彼此色相拉开，保证小地图上一眼能区分类型。
// 文本节点直接复用品牌青柠，因为它是画布里最常出现的类型。
export const NODE_TYPE_COLOR: Record<string, string> = {
  [NODE_TYPE.TEXT]: "#c7f43d",
  [NODE_TYPE.IMAGE]: "#4ade80",
  [NODE_TYPE.VIDEO]: "#38bdf8",
  [NODE_TYPE.AUDIO]: "#ffb020",
  [NODE_TYPE.GROUP]: "#a78bfa",
  [NODE_TYPE.DIRECTOR]: "#a78bfa",
};

// ── 连接轨道（Handle）与连线端点 ──
// 连接轨道悬浮于节点边缘外侧：宽 RAIL_WIDTH、高 min(节点高, RAIL_HEIGHT)，
// 圆点（直径 RAIL_DOT）静止于贴节点边缘的偏移位（RAIL_REST_OFFSET），hover 时
// 在 ±RAIL_FOLLOW_LIMIT 屏幕像素内二维跟随鼠标——纯视觉反馈，连线锚点恒为
// 节点边缘垂直正中（参考 open-ai-canvas：按鼠标落点比例取 Y 会让多线沿边散开，
// 视觉上像节点长出很多“伪端口”）。见 controls/ConnectionSideRail.tsx 与 globals.css。
// React Flow 的连线端点落在轨道上而非节点边缘，需要按方位把端点向节点方向收回：
//   - 已建立连线：getHandlePosition(center=false) → 轨道外侧边缘 → 收回 轨道宽
//   - 拖拽预览线：getHandlePosition(center=true)  → 轨道中心      → 收回 半轨道宽
export const RAIL_WIDTH = 80;
export const RAIL_HEIGHT = 80;
export const RAIL_DOT = 20;
export const RAIL_FOLLOW_LIMIT = 30;
export const RAIL_REST_OFFSET = 25;

/** 拖线吸附半径（React Flow connectionRadius）。xyflow 默认 20px 是按老式小圆点设计的；
 *  吸附判定取「指针到 Handle 中心」的距离，而 Handle 中心在轨道正中，要整条轨道
 *  （最远到四角）都能吸附落线，需取轨道的外接圆半径 */
export const RAIL_CONNECT_RADIUS = Math.hypot(RAIL_WIDTH, RAIL_HEIGHT) / 2;

/** 通用 Handle（非轨道，如框选外框 Handle）直径，经 --handle-size 注入 CSS */
export const HANDLE_SIZE = 24;

function insetBy(
  position: string | undefined,
  x: number,
  y: number,
  outerOffset: number,
  innerOffset = outerOffset
): { x: number; y: number } {
  switch (position) {
    case "left":
      return { x: x + outerOffset, y };
    case "top":
      return { x, y: y + outerOffset };
    case "right":
      return { x: x - innerOffset, y };
    case "bottom":
      return { x, y: y - innerOffset };
    default:
      return { x, y };
  }
}

/** 已建立连线（Edge）的端点：基准为轨道外侧边缘，收回 轨道宽 */
export const insetEdgeAnchor = (position: string | undefined, x: number, y: number) =>
  insetBy(position, x, y, RAIL_WIDTH);

/** 拖拽预览线的端点：基准为轨道中心，收回 半轨道宽 */
export const insetHandleCenter = (position: string | undefined, x: number, y: number) =>
  insetBy(position, x, y, RAIL_WIDTH / 2);

/** 未知节点类型的兜底色：直接用品牌青柠，避免再出现第二种强调色 */
export const DEFAULT_NODE_COLOR = "#c7f43d";

/**
 * 连线（管道）本体色：中性灰，用 CSS 变量以跟随明暗主题。
 * 与流光色 DOT_COLOR 分离是刻意的——底线若与流光同色，
 * 流光的水滴形状会被淹没看不出来。
 * 连线不画箭头：方向由流光水滴的朝向表达（未选中时无流光，靠节点布局与句柄方位判断）。
 * 新建连线（createEdge）与 defaultEdgeOptions 都引用此处，避免硬编码散落。
 */
export const EDGE_BASE_COLOR = "var(--canvas-text-muted)";

// ── 节点连接规则 ──
// 连接规则区分「输入」与「输出」两个方向：
//   • 输出规则：从某节点右侧 source Handle 拖出时，可创建的目标节点类型。
//   • 输入规则：从某节点左侧 target Handle 拉入时，可接受的来源节点类型。
// 规则（依据产品定义）：
//   文本节点 输入 → 文本、音频、图片、视频    输出 → 文本、音频、图片、视频
//   图片节点 输入 → 文本、图片               输出 → 文本、图片、视频
//   视频节点 输入 → 文本、图片、音频、视频    输出 → 文本、视频
//   音频节点 输入 → 文本、音频               输出 → 文本、音频、视频
export const VALID_CONNECTION_OUTPUTS: Record<string, readonly string[]> = {
  [NODE_TYPE.TEXT]:  [NODE_TYPE.TEXT, NODE_TYPE.AUDIO, NODE_TYPE.IMAGE, NODE_TYPE.VIDEO],
  [NODE_TYPE.IMAGE]: [NODE_TYPE.TEXT, NODE_TYPE.IMAGE, NODE_TYPE.VIDEO],
  [NODE_TYPE.VIDEO]: [NODE_TYPE.TEXT, NODE_TYPE.VIDEO],
  [NODE_TYPE.AUDIO]: [NODE_TYPE.TEXT, NODE_TYPE.AUDIO, NODE_TYPE.VIDEO],
};

export const VALID_CONNECTION_INPUTS: Record<string, readonly string[]> = {
  [NODE_TYPE.TEXT]:  [NODE_TYPE.TEXT, NODE_TYPE.AUDIO, NODE_TYPE.IMAGE, NODE_TYPE.VIDEO],
  [NODE_TYPE.IMAGE]: [NODE_TYPE.TEXT, NODE_TYPE.IMAGE],
  [NODE_TYPE.VIDEO]: [NODE_TYPE.TEXT, NODE_TYPE.IMAGE, NODE_TYPE.AUDIO, NODE_TYPE.VIDEO],
  [NODE_TYPE.AUDIO]: [NODE_TYPE.TEXT, NODE_TYPE.AUDIO],
};

/**
 * 判断从 sourceType 到 targetType 的连接是否合法。
 * @param sourceType 连接起点（source Handle 所在）节点类型
 * @param targetType 连接终点（target Handle 所在）节点类型
 */
export function canConnect(sourceType: string | undefined, targetType: string | undefined): boolean {
  if (!sourceType || !targetType) return false;
  return VALID_CONNECTION_OUTPUTS[sourceType]?.includes(targetType) ?? false;
}

/** 判断从某节点输入框（target）可以接受的目标节点类型是否合法 */
export function canConnectToInput(inputType: string | undefined, sourceType: string | undefined): boolean {
  if (!inputType || !sourceType) return false;
  return VALID_CONNECTION_INPUTS[inputType]?.includes(sourceType) ?? false;
}

export function getNodeColor(type: string | undefined): string {
  if (!type) return DEFAULT_NODE_COLOR;
  return NODE_TYPE_COLOR[type] ?? DEFAULT_NODE_COLOR;
}

// ── 分组节点配色 ──
// 分组节点的可选配色，用于视觉归类。每个色项提供边框色与填充色，
// 填充色为低透明度以免遮挡组内节点。data.color 仅存储 key，便于后续统一调整色板。
export interface GroupColorPreset {
  /** 边框 / 标题图标色 */
  border: string;
  /** 内部填充色（低透明度） */
  fill: string;
}

export const GROUP_COLOR_KEYS = [
  "default", "brown", "blue", "green", "yellow", "orange", "red", "purple", "pink", "cyan",
] as const;

export type GroupColorKey = (typeof GROUP_COLOR_KEYS)[number];

export const GROUP_COLORS: Record<GroupColorKey, GroupColorPreset> = {
  default: { border: "rgba(255,255,255,0.10)", fill: "rgba(255,255,255,0.10)" },
  brown:   { border: "rgba(150,100,60,0.55)",  fill: "rgba(150,100,60,0.12)" },
  blue:    { border: "rgba(22,119,255,0.55)",  fill: "rgba(22,119,255,0.12)" },
  green:   { border: "rgba(52,199,89,0.55)",   fill: "rgba(52,199,89,0.12)" },
  yellow:  { border: "rgba(250,219,20,0.55)",  fill: "rgba(250,219,20,0.12)" },
  orange:  { border: "rgba(255,149,0,0.55)",   fill: "rgba(255,149,0,0.12)" },
  red:     { border: "rgba(255,59,48,0.55)",   fill: "rgba(255,59,48,0.12)" },
  purple:  { border: "rgba(114,46,209,0.55)",  fill: "rgba(114,46,209,0.12)" },
  pink:    { border: "rgba(235,47,150,0.55)",  fill: "rgba(235,47,150,0.12)" },
  cyan:    { border: "rgba(48,213,200,0.55)",  fill: "rgba(48,213,200,0.12)" },
};

export const DEFAULT_GROUP_COLOR_KEY: GroupColorKey = "default";

export function getGroupColor(key?: string): GroupColorPreset {
  return GROUP_COLORS[(key as GroupColorKey)] ?? GROUP_COLORS[DEFAULT_GROUP_COLOR_KEY];
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
