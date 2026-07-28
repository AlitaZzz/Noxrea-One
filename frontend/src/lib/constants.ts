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
export const TEXT_NODE_DEFAULT_WIDTH = 450; // 4:3 (338 * 4 / 3)
export const TEXT_NODE_MIN_WIDTH = 120;
export const TEXT_NODE_MIN_HEIGHT = 60;

// Copy/paste offset
export const PASTE_OFFSET = { x: 30, y: 30 };

// Group node
export const GROUP_NODE_PADDING = 40;
export const GROUP_NODE_MIN_WIDTH = 200;
export const GROUP_NODE_MIN_HEIGHT = 120;

// Image/video thumbnail display (short side max pixels)
/** 节点显示尺寸上限（长边约束，px） */
export const NODE_DISPLAY_MAX = 600;
