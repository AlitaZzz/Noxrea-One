/**
 * 画布项目状态仓库。
 * 管理项目列表与当前激活项目（本地记忆 activeId），
 * 负责项目的增删改查以及画布数据的序列化保存与加载。
 */
import { create } from "zustand";

import type { AnyEdge, BackgroundType, ThemeMode, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";
import { projectApi } from "@/features/project/api";
import type { CanvasProject } from "@/features/project/types";
import { DEFAULT_BACKGROUND, DEFAULT_THEME,DEFAULT_VIEWPORT } from "@/lib/constants";

// ===== localStorage helpers (active project only) =====

function loadLocalActiveId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("noxrea-canvas-active-project");
}

function saveLocalActiveId(id: string | null) {
  if (typeof window === "undefined") return;
  if (id) localStorage.setItem("noxrea-canvas-active-project", id);
  else localStorage.removeItem("noxrea-canvas-active-project");
}

// ===== API helpers =====

interface CanvasData {
  viewport?: ViewportState;
  background?: BackgroundType;
  theme?: ThemeMode;
  minimapVisible?: boolean;
  snapToGrid?: boolean;
  agentModel?: string;
  nodes?: unknown[];
  edges?: unknown[];
}

interface ServerProject {
  id: number;
  name: string;
  canvasData?: CanvasData;
  updatedAt: string;
}

function mapServerProject(p: ServerProject): CanvasProject {
  return {
    id: String(p.id),
    name: p.name,
    createdAt: Date.now(),
    updatedAt: new Date(p.updatedAt).getTime(),
    viewport: p.canvasData?.viewport || DEFAULT_VIEWPORT,
    background: p.canvasData?.background || DEFAULT_BACKGROUND,
    theme: p.canvasData?.theme || DEFAULT_THEME,
    minimapVisible: p.canvasData?.minimapVisible ?? true,
    snapToGrid: p.canvasData?.snapToGrid || false,
    agentModel: p.canvasData?.agentModel,
    nodes: (p.canvasData?.nodes || []) as AnyNode[],
    edges: (p.canvasData?.edges || []) as AnyEdge[],
  };
}

async function fetchProjects(): Promise<CanvasProject[]> {
  try {
    const res = await projectApi.listProjects<ServerProject[]>();
    if (res.code === 200 && res.data) {
      return res.data.map(mapServerProject);
    }
  } catch { /* offline or error */ }
  return [];
}

async function fetchProjectById(id: string): Promise<CanvasProject | null> {
  try {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) return null;
    const res = await projectApi.getProject<ServerProject>(numericId);
    if (res.code === 200 && res.data) {
      return mapServerProject(res.data);
    }
  } catch { /* offline or error */ }
  return null;
}

async function apiCreateProject(name: string): Promise<CanvasProject | null> {
  try {
    const res = await projectApi.createProject<ServerProject>(name, { viewport: DEFAULT_VIEWPORT, background: DEFAULT_BACKGROUND, theme: DEFAULT_THEME, nodes: [], edges: [] });
    if (res.code === 200 && res.data) {
      return {
        id: String(res.data.id),
        name: res.data.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        viewport: DEFAULT_VIEWPORT,
        background: DEFAULT_BACKGROUND,
        theme: DEFAULT_THEME,
        nodes: [],
        edges: [],
      };
    }
  } catch { /* */ }
  return null;
}

async function apiDeleteProject(projectId: string) {
  try {
    const id = parseInt(projectId, 10);
    if (isNaN(id)) return;
    await projectApi.deleteProject(id);
  } catch { /* */ }
}

// ===== Store =====

interface ProjectState {
  projects: CanvasProject[];
  activeProjectId: string | null;

  activeProject: () => CanvasProject | undefined;
  refreshProject: (id: string) => Promise<CanvasProject | null>;
  createProject: (name?: string) => Promise<CanvasProject>;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  deleteProjects: (ids: string[]) => void;
  setActiveProject: (id: string) => void;
  syncCanvasState: (id: string, nodes: unknown[], edges: unknown[], viewport: ViewportState, background: BackgroundType, theme: ThemeMode, minimapVisible?: boolean, snapToGrid?: boolean, agentModel?: string | null) => void;
  refreshProjects: () => Promise<void>;
  initialize: () => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,

  activeProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId);
  },

  refreshProject: async (id) => {
    const fresh = await fetchProjectById(id);
    if (!fresh) return null;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? fresh : p)),
    }));
    return fresh;
  },

  createProject: async (name) => {
    const count = get().projects.length;
    const projectName = name || `Project ${count + 1}`;
    const project = await apiCreateProject(projectName);
    if (project) {
      set((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
      return project;
    }
    throw new Error("Failed to create project");
  },

  renameProject: (id, name) => {
    set((s) => ({
      projects: s.projects.map((p) => p.id === id ? { ...p, name, updatedAt: Date.now() } : p),
    }));
    const nid = parseInt(id, 10);
    if (!isNaN(nid)) {
      projectApi.updateProject(nid, { name }).catch(() => {});
    }
  },

  deleteProject: (id) => {
    apiDeleteProject(id).catch(() => {});
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id);
      let { activeProjectId } = s;
      if (activeProjectId === id) {
        activeProjectId = projects.length > 0 ? projects[0].id : null;
        saveLocalActiveId(activeProjectId);
      }
      return { projects, activeProjectId };
    });
  },

  deleteProjects: (ids) => {
    ids.forEach((id) => apiDeleteProject(id).catch(() => {}));
    const idSet = new Set(ids);
    set((s) => {
      const projects = s.projects.filter((p) => !idSet.has(p.id));
      let { activeProjectId } = s;
      if (activeProjectId && idSet.has(activeProjectId)) {
        activeProjectId = projects.length > 0 ? projects[0].id : null;
        saveLocalActiveId(activeProjectId);
      }
      return { projects, activeProjectId };
    });
  },

  setActiveProject: (id) => {
    set({ activeProjectId: id });
    saveLocalActiveId(id);
  },

  syncCanvasState: (id, nodes, edges, viewport, background, theme, minimapVisible, snapToGrid, agentModel) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, nodes: nodes as AnyNode[], edges: edges as AnyEdge[], viewport, background, theme, minimapVisible, snapToGrid, agentModel: agentModel ?? undefined, updatedAt: Date.now() } : p
      ),
    }));
  },

  refreshProjects: async () => {
    const projects = await fetchProjects();
    set((s) => {
      let { activeProjectId } = s;
      if (activeProjectId && !projects.find((p) => p.id === activeProjectId)) {
        activeProjectId = projects.length > 0 ? projects[0].id : null;
        saveLocalActiveId(activeProjectId);
      }
      return { projects, activeProjectId };
    });
  },

  initialize: async () => {
    const projects = await fetchProjects();
    let activeId: string | null = loadLocalActiveId();
    if (projects.length > 0) {
      const validId = activeId && projects.find((p) => p.id === activeId) ? activeId : projects[0].id;
      activeId = validId;
    }
    set({ projects, activeProjectId: activeId });
  },
}));
