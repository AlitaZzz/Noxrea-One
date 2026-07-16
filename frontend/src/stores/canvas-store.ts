import { create } from "zustand";
import type { Edge } from "@xyflow/react";
import type { ViewportState, BackgroundType, ThemeMode, HistorySnapshot, AnyNode } from "@/lib/types";
import { DEFAULT_VIEWPORT, DEFAULT_BACKGROUND, DEFAULT_THEME } from "@/lib/constants";
import { saveManager } from "@/lib/save-manager";

/**
 * Mark canvas as modified — SaveManager 负责 trailing save。
 * 内部自动先调用 syncCanvasState 同步项目列表内存状态。
 */
export function markDirty() {
  saveManager.markDirty();
}

/** 等待保存完成并确保最终状态已落盘（项目切换等场景） */
export function flushAndWait(): Promise<void> {
  return saveManager.flushAndWait();
}

interface CanvasState {
  // Viewport
  viewport: ViewportState;
  setViewport: (viewport: ViewportState) => void;

  // Nodes and edges (controlled mode)
  nodes: AnyNode[];
  edges: Edge[];
  setNodes: (nodes: AnyNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNodes: (nodes: AnyNode[]) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>, style?: Record<string, unknown>) => void;
  removeNodes: (nodeIds: string[]) => void;
  removeEdges: (edgeIds: string[]) => void;

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

  // Snap to grid
  snapToGrid: boolean;
  toggleSnapToGrid: () => void;
  snapGridSize: number;

  // Persistence
  restoreFromProject: (project: { nodes?: AnyNode[]; edges?: Edge[]; viewport?: ViewportState; background?: BackgroundType; theme?: ThemeMode }) => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  viewport: DEFAULT_VIEWPORT,
  setViewport: (viewport) => {
    set({ viewport });
    saveManager.markDirty();
  },

  nodes: [],
  edges: [],
  setNodes: (nodes) => {
    set({ nodes });
    saveManager.markDirty();
  },
  setEdges: (edges) => {
    set({ edges });
    saveManager.markDirty();
  },
  addNodes: (nodes) => {
    set((s) => ({ nodes: [...s.nodes, ...nodes] }));
    saveManager.markDirty();
  },
  updateNodeData: (nodeId, data, style) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ...data }, style: style ?? n.style }
          : n
      ),
    }));
    saveManager.markDirty();
  },
  removeNodes: (nodeIds) => {
    const idSet = new Set(nodeIds);
    set((s) => ({
      nodes: s.nodes.filter((n) => !idSet.has(n.id)),
      edges: s.edges.filter(
        (e) => !idSet.has(e.source) && !idSet.has(e.target)
      ),
    }));
    saveManager.markDirty();
  },
  removeEdges: (edgeIds) => {
    const idSet = new Set(edgeIds);
    set((s) => ({
      edges: s.edges.filter((e) => !idSet.has(e.id)),
    }));
    saveManager.markDirty();
  },
  background: DEFAULT_BACKGROUND,
  setBackground: (background) => {
    set({ background });
    saveManager.markDirty();
  },

  theme: DEFAULT_THEME,
  setTheme: (theme) => {
    set({ theme });
    saveManager.markDirty();
  },
  toggleTheme: () => {
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" }));
    saveManager.markDirty();
  },

  minimapVisible: true,
  toggleMinimap: () => {
    set((s) => ({ minimapVisible: !s.minimapVisible }));
    saveManager.markDirty();
  },

  resetViewport: () => set({ viewport: DEFAULT_VIEWPORT }),

  shortcutsVisible: false,
  setShortcutsVisible: (v) => set({ shortcutsVisible: v }),

  snapToGrid: false,
  toggleSnapToGrid: () => {
    set((s) => ({ snapToGrid: !s.snapToGrid }));
    saveManager.markDirty();
  },
  snapGridSize: 20,

  /** 从项目恢复画布状态 */
  restoreFromProject: (project: { nodes?: AnyNode[]; edges?: Edge[]; viewport?: ViewportState; background?: BackgroundType; theme?: ThemeMode; minimapVisible?: boolean; snapToGrid?: boolean }) => {
    set({
      nodes: ((project.nodes || []) as AnyNode[]).map((n) => ({
        ...n,
        data: { ...n.data },
      })),
      edges: (project.edges || []) as Edge[],
      viewport: project.viewport || DEFAULT_VIEWPORT,
      background: project.background || DEFAULT_BACKGROUND,
      theme: project.theme || DEFAULT_THEME,
      minimapVisible: project.minimapVisible !== false,
      snapToGrid: project.snapToGrid || false,
    });
  },
}));

/** 获取当前画布快照（供 undo/redo 使用） */
export function takeCanvasSnapshot(): HistorySnapshot {
  const s = useCanvasStore.getState();
  return {
    nodes: JSON.parse(JSON.stringify(s.nodes)),
    edges: JSON.parse(JSON.stringify(s.edges)),
    viewport: { ...s.viewport },
    background: s.background,
    theme: s.theme,
    minimapVisible: s.minimapVisible,
    snapToGrid: s.snapToGrid,
  };
}

/** 获取视口中心的世界坐标 */
export function getViewportCenter(): { x: number; y: number } {
  const vp = useCanvasStore.getState().viewport;
  return {
    x: -vp.x / vp.zoom + (window.innerWidth / 2) / vp.zoom,
    y: -vp.y / vp.zoom + (window.innerHeight / 2) / vp.zoom,
  };
}
