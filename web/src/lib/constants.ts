import type { BackgroundType, ThemeMode,ViewportState } from "./types";

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
