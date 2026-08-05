/**
 * 画布核心状态仓库。
 * 持有节点 / 连线 / 视口 / 背景 / 主题等画布状态与各类浮层开关，
 * 提供节点增删改与快照能力，并通过 SaveManager 做脏标记与延迟保存。
 * 视口高频变更走模块级变量以避免重渲染循环。
 */
import type { Edge } from "@xyflow/react";
import { create } from "zustand";

import { saveManager } from "@/features/project/save-manager";
import { DEFAULT_BACKGROUND, DEFAULT_THEME,DEFAULT_VIEWPORT } from "@/lib/constants";
import type { BackgroundType, ThemeMode, ViewportState } from "@/lib/types/canvas";
import type { AnyNode } from "@/lib/types/nodes";
import type { HistorySnapshot } from "@/lib/types/project";
import { useHistoryStore } from "@/stores/history-store";

/** updateNodeData 自动压栈防抖时间（ms） */
const HISTORY_THROTTLE = 300;
let _lastHistoryTime = 0;

/**
 * 模块级 viewport 跟踪变量。
 * onViewportChange 高频触发时只更新此变量（不触发 Zustand set），
 * 避免 useSyncExternalStore 同步重渲染 -> React Flow 再次 emit onViewportChange 的无限循环。
 * 保存/快照/undo 时从此变量读取最新值。
 */
let _liveViewport: ViewportState = DEFAULT_VIEWPORT;

/**
 * Mark canvas as modified — SaveManager 负责 trailing save。
 * 内部自动先调用 syncCanvasState 同步项目列表内存状态。
 */
export function markDirty() {
  saveManager.markDirty();
}

/** 立即保存（离散操作，100ms 合并） */
export function markDirtyImmediate() {
  saveManager.markDirtyImmediate();
}

/**
 * 高频 viewport 变更入口（onViewportChange 调用）。
 * 只更新模块级变量 + markDirty，不触发 Zustand set()，避免渲染循环。
 */
export function syncLiveViewport(vp: ViewportState) {
  _liveViewport = vp;
  saveManager.markDirty();
}

/** 读取最新 viewport（供 save / snapshot / getViewportCenter 使用） */
export function getLiveViewport(): ViewportState {
  return _liveViewport;
}

/** 等待保存完成并确保最终状态已落盘（项目切换等场景） */
export function flushAndWait(): Promise<void> {
  return saveManager.flushAndWait();
}

/** 页面卸载 / 组件卸载时兜底保存（fire-and-forget，keepalive） */
export function flushOnUnload(): void {
  saveManager.flushOnUnload();
}

/** 自动压栈 throttle 辅助函数 */
function maybePushHistory(options?: { skipHistory?: boolean; forceHistory?: boolean }) {
  if (options?.skipHistory) return;
  const now = Date.now();
  if (options?.forceHistory || now - _lastHistoryTime > HISTORY_THROTTLE) {
    useHistoryStore.getState().push(takeCanvasSnapshot());
    _lastHistoryTime = now;
  }
}

interface CanvasState {
  // Viewport
  viewport: ViewportState;
  setViewport: (viewport: ViewportState) => void;

  // Nodes and edges (controlled mode)
  nodes: AnyNode[];
  edges: Edge[];
  setNodes: (nodes: AnyNode[]) => void;
  setEdges: (edges: Edge[], options?: { skipHistory?: boolean }) => void;
  addNodes: (nodes: AnyNode[], options?: { skipHistory?: boolean }) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>, style?: Record<string, unknown>, options?: { skipHistory?: boolean; forceHistory?: boolean }) => void;
  removeNodes: (nodeIds: string[], options?: { skipHistory?: boolean }) => void;
  removeEdges: (edgeIds: string[], options?: { skipHistory?: boolean }) => void;

  // Background
  background: BackgroundType;
  setBackground: (bg: BackgroundType) => void;

  // Theme
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;

  // Minimap visibility
  minimapVisible: boolean;
  toggleMinimap: () => void;

  // Reset viewport
  resetViewport: () => void;

  // Shortcuts help
  shortcutsVisible: boolean;
  setShortcutsVisible: (v: boolean) => void;

  // Modal open (blocks canvas keyboard shortcuts)
  modalOpen: boolean;
  setModalOpen: (v: boolean) => void;

  // Annotation mode (hides node toolbar for the annotating node)
  annotatingNodeId: string | null;
  setAnnotatingNodeId: (id: string | null) => void;
  croppingNodeId: string | null;
  setCroppingNodeId: (id: string | null) => void;

  // Director overlay
  directorOverlayOpen: boolean;
  setDirectorOverlayOpen: (v: boolean) => void;

  // Agent model (persisted to canvasData, project-level)
  agentModel: string | null;
  setAgentModel: (model: string) => void;

  // Snap to grid
  snapToGrid: boolean;
  toggleSnapToGrid: () => void;
  snapGridSize: number;
  /** 节点间对齐吸附阈值（px），默认 5 */
  snapThreshold: number;

  // Persistence
  restoreFromProject: (project: { nodes?: AnyNode[]; edges?: Edge[]; viewport?: ViewportState; background?: BackgroundType; theme?: ThemeMode; minimapVisible?: boolean; snapToGrid?: boolean; agentModel?: string }) => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  viewport: DEFAULT_VIEWPORT,
  setViewport: (viewport) => {
    _liveViewport = viewport;
    set({ viewport });
    saveManager.markDirty();
  },

  nodes: [],
  edges: [],
  setNodes: (nodes) => {
    set({ nodes });
  },
  setEdges: (edges, options) => {
    maybePushHistory(options);
    set({ edges });
  },
  addNodes: (nodes, options) => {
    maybePushHistory(options);
    set((s) => ({ nodes: [...s.nodes, ...nodes] }));
    saveManager.markDirtyImmediate();
  },
  updateNodeData: (nodeId, data, style, options) => {
    maybePushHistory(options);
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? ({ ...n, data: { ...n.data, ...data }, style: style ?? n.style } as AnyNode)
          : n
      ),
    }));
    saveManager.markDirty();
  },
  removeNodes: (nodeIds, options) => {
    maybePushHistory(options);
    const idSet = new Set(nodeIds);
    set((s) => ({
      nodes: s.nodes.filter((n) => !idSet.has(n.id)),
      edges: s.edges.filter(
        (e) => !idSet.has(e.source) && !idSet.has(e.target)
      ),
    }));
    saveManager.markDirtyImmediate();
  },
  removeEdges: (edgeIds, options) => {
    maybePushHistory(options);
    const idSet = new Set(edgeIds);
    set((s) => ({
      edges: s.edges.filter((e) => !idSet.has(e.id)),
    }));
    saveManager.markDirtyImmediate();
  },
  background: DEFAULT_BACKGROUND,
  setBackground: (background) => {
    set({ background });
    saveManager.markDirtyImmediate();
  },

  theme: DEFAULT_THEME,
  setTheme: (theme) => {
    set({ theme });
  },
  toggleTheme: () => {
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" }));
    saveManager.markDirtyImmediate();
  },

  minimapVisible: true,
  toggleMinimap: () => {
    set((s) => ({ minimapVisible: !s.minimapVisible }));
    saveManager.markDirtyImmediate();
  },

  resetViewport: () => {
    _liveViewport = DEFAULT_VIEWPORT;
    set({ viewport: DEFAULT_VIEWPORT });
  },

  shortcutsVisible: false,
  setShortcutsVisible: (v) => set({ shortcutsVisible: v }),

  modalOpen: false,
  setModalOpen: (v) => set({ modalOpen: v }),

  annotatingNodeId: null,
  setAnnotatingNodeId: (id) => set({ annotatingNodeId: id }),
  croppingNodeId: null,
  setCroppingNodeId: (id) => set({ croppingNodeId: id }),

  directorOverlayOpen: false,
  setDirectorOverlayOpen: (v) => set({ directorOverlayOpen: v }),

  agentModel: null,
  setAgentModel: (model) => {
    set({ agentModel: model });
    saveManager.markDirtyImmediate();
  },

  snapToGrid: false,
  toggleSnapToGrid: () => {
    set((s) => ({ snapToGrid: !s.snapToGrid }));
    saveManager.markDirtyImmediate();
  },
  snapGridSize: 20,
  snapThreshold: 5,

  /** 从项目恢复画布状态 */
  restoreFromProject: (project: { nodes?: AnyNode[]; edges?: Edge[]; viewport?: ViewportState; background?: BackgroundType; theme?: ThemeMode; minimapVisible?: boolean; snapToGrid?: boolean; agentModel?: string }) => {
    const vp = project.viewport || DEFAULT_VIEWPORT;
    _liveViewport = vp;
    set({
      nodes: ((project.nodes || []) as AnyNode[]).map((n) => ({
        ...n,
        data: { ...n.data },
      })) as AnyNode[],
      edges: (project.edges || []) as Edge[],
      viewport: vp,
      background: project.background || DEFAULT_BACKGROUND,
      theme: project.theme || DEFAULT_THEME,
      minimapVisible: project.minimapVisible !== false,
      snapToGrid: project.snapToGrid || false,
      agentModel: project.agentModel ?? null,
    });
  },
}));

/** 获取当前画布快照（供 undo/redo 使用） */
export function takeCanvasSnapshot(): HistorySnapshot {
  const s = useCanvasStore.getState();
  return {
    nodes: JSON.parse(JSON.stringify(s.nodes)),
    edges: JSON.parse(JSON.stringify(s.edges)),
    viewport: { ..._liveViewport },
    background: s.background,
    theme: s.theme,
    minimapVisible: s.minimapVisible,
    snapToGrid: s.snapToGrid,
  };
}

/** 获取视口中心的世界坐标 */
export function getViewportCenter(): { x: number; y: number } {
  const vp = _liveViewport;
  return {
    x: -vp.x / vp.zoom + (window.innerWidth / 2) / vp.zoom,
    y: -vp.y / vp.zoom + (window.innerHeight / 2) / vp.zoom,
  };
}

/**
 * 在视口中心附近为新节点寻找位置。
 *
 * 从视口中心开始，每次固定偏移一小段距离（默认 30px），
 * 允许部分重叠，仅保证用户能识别新节点。类似 Figma 连续粘贴行为。
 *
 * @param nodeSize 新节点的尺寸
 * @param options.offset 每次偏移量（默认 30px）
 * @returns 节点左上角坐标
 */
export function findFreePosition(
  nodeSize: { width: number; height: number },
  options?: { offset?: number },
): { x: number; y: number } {
  const offset = options?.offset ?? 30;
  const { x: cx, y: cy } = getViewportCenter();
  const nodes = useCanvasStore.getState().nodes;

  // 偏移次数 = 当前视口附近的节点数
  const i = nodes.length;

  return {
    x: cx - nodeSize.width / 2 + i * offset,
    y: cy - nodeSize.height / 2 + i * offset,
  };
}
