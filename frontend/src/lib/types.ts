// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEdge = any;

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

export interface TextNodeData {
  label: string;
  content: string;
}

export interface ImageNodeData {
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
}

// ============================================================
// Model configuration
// ============================================================

export type ModelCapability = "text" | "image" | "video" | "audio";

export interface ModelInfo {
  id: string;
  name: string;
  capabilities: ModelCapability[];
}


export interface ModelChannel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelInfo[];
}

export interface GroupNodeData {
  label: string;
}

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
  members?: Array<{
    type?: string;
    bodyType?: string;
    color?: string;
    pos: [number, number, number];
    rot: [number, number, number, number];
    visible: boolean;
    fov?: number;
    roll?: number;
    kind?: string;
    pose?: { mode: "preset" | "manual"; preset?: string | null; values?: Record<string, number> };
  }>;
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

export interface DirectorNodeData {
  label: string;
  directorState?: DirectorStateData;
}

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
}

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
