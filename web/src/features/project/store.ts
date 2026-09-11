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
import { resolveResultError } from "@/lib/api/error-message";
import { DEFAULT_BACKGROUND, DEFAULT_THEME, DEFAULT_VIEWPORT } from "@/lib/constants";
import { showGlobalNotification } from "@/lib/global-notification";

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
  id: string;
  name: string;
  revision?: number;
  canvasData?: CanvasData;
  updatedAt: string;
}

function mapServerProject(p: ServerProject): CanvasProject {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision ?? 1,
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

/**
 * 拉取项目列表。
 * 返回 null 表示「请求失败」（离线 / 5xx / 业务码非 200），与「成功但为空」区分开：
 * 调用方据此保留本地数据，避免短暂断网被误判成「项目全部丢失」。
 */
async function fetchProjects(): Promise<CanvasProject[] | null> {
  try {
    const res = await projectApi.listProjects<ServerProject[]>();
    if (res.code === 200 && res.data) {
      return res.data.map(mapServerProject);
    }
  } catch { /* offline or error */ }
  return null;
}

async function fetchProjectById(id: string): Promise<CanvasProject | null> {
  try {
    const res = await projectApi.getProject<ServerProject>(id);
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
        revision: res.data.revision ?? 1,
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

/** 删除项目；返回是否成功与失败文案（供调用方回滚与提示） */
async function apiDeleteProject(projectId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await projectApi.deleteProject(projectId);
    if (res.code === 200) return { ok: true };
    return { ok: false, message: resolveResultError(res, "project.delete_failed") };
  } catch { /* offline or error */ }
  return { ok: false, message: resolveResultError(null, "project.delete_failed") };
}

/** 失败提示（store 层统一负责，UI 无需各自处理） */
function notifyError(message: string) {
  showGlobalNotification().error({ title: message, placement: "bottomRight", duration: 6 });
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
  updateProjectRevision: (id: string, revision: number) => void;
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
    const prevName = get().projects.find((p) => p.id === id)?.name;
    const baseRevision = get().projects.find((p) => p.id === id)?.revision ?? 1;
    // 乐观更新，失败回滚：此前无论响应码如何都留在本地，刷新后名称又变回去
    set((s) => ({
      projects: s.projects.map((p) => p.id === id ? { ...p, name, updatedAt: Date.now() } : p),
    }));
    void (async () => {
      try {
        let res = await projectApi.updateProject(id, { name, baseRevision });

        // 409 表示本地版本落后；重命名是幂等更新，可同步版本后立即重试一次，
        // 避免用户下一次画布保存先吃一次无意义的版本冲突。
        if (res.code === 409 && typeof res.ctx?.revision === "number") {
          const currentRevision = res.ctx.revision;
          get().updateProjectRevision(id, currentRevision);
          res = await projectApi.updateProject(id, { name, baseRevision: currentRevision });
        }

        // 第二次仍然冲突说明服务端状态已经不可预判；刷新一次本地项目，
        // 让 revision 和名称回到服务端事实，再交给用户重新输入。
        if (res.code === 409) {
          // 先保留第二次冲突响应中的最新版本，即使项目详情刷新失败，
          // 本地也不至于继续带着过期 revision 发起后续保存。
          if (typeof res.ctx?.revision === "number") {
            get().updateProjectRevision(id, res.ctx.revision);
          }
          const fresh = await get().refreshProject(id);
          if (!fresh && prevName !== undefined) {
            set((s) => ({
              projects: s.projects.map((p) => (p.id === id ? { ...p, name: prevName } : p)),
            }));
          }
          notifyError(resolveResultError(res, "project.rename_failed"));
          return;
        }

        if (res.code === 200 && typeof res.data?.revision === "number") {
          get().updateProjectRevision(id, res.data.revision);
          return;
        }
        throw new Error(resolveResultError(res, "project.rename_failed"));
      } catch (e) {
        if (prevName !== undefined) {
          set((s) => ({
            projects: s.projects.map((p) => (p.id === id ? { ...p, name: prevName } : p)),
          }));
        }
        notifyError(e instanceof Error ? e.message : resolveResultError(null, "project.rename_failed"));
      }
    })();
  },

  deleteProject: (id) => {
    // 失败回滚用：删除是破坏性操作，不能「假删成功」
    const snapshot = get().projects;
    const snapshotActiveId = get().activeProjectId;
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id);
      let { activeProjectId } = s;
      if (activeProjectId === id) {
        activeProjectId = projects.length > 0 ? projects[0].id : null;
        saveLocalActiveId(activeProjectId);
      }
      return { projects, activeProjectId };
    });
    void (async () => {
      const { ok, message } = await apiDeleteProject(id);
      if (ok) return;
      notifyError(message ?? resolveResultError(null, "project.delete_failed"));
      set({ projects: snapshot, activeProjectId: snapshotActiveId });
      saveLocalActiveId(snapshotActiveId);
    })();
  },

  deleteProjects: (ids) => {
    const snapshot = get().projects;
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
    void (async () => {
      const results = await Promise.all(ids.map((id) => apiDeleteProject(id)));
      const failedIds = new Set(ids.filter((_, i) => !results[i].ok));
      if (failedIds.size === 0) return;
      notifyError(results.find((r) => !r.ok)?.message ?? resolveResultError(null, "project.delete_failed"));
      // 只把删除失败的项放回列表：成功删除的在服务端已不存在，
      // 整表回滚会让它们变成「刷新才消失」的幽灵项目
      const restored = snapshot.filter((p) => failedIds.has(p.id));
      set((s) => {
        const keptIds = new Set(s.projects.map((p) => p.id));
        const projects = [...s.projects, ...restored.filter((p) => !keptIds.has(p.id))];
        let { activeProjectId } = s;
        if ((!activeProjectId || !projects.some((p) => p.id === activeProjectId)) && projects.length > 0) {
          activeProjectId = projects[0].id;
          saveLocalActiveId(activeProjectId);
        }
        return { projects, activeProjectId };
      });
    })();
  },

  /** 保存成功或版本冲突后同步服务端 revision，确保下一次请求携带正确版本。 */
  updateProjectRevision: (id, revision) => {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, revision } : p)),
    }));
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
    // 拉取失败：保留现有列表与激活项目，宁可展示过期数据也不能清空
    // （空列表会让用户以为项目被删，且顺带重置 activeProjectId）
    if (!projects) return;
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
    // 同样区分失败与空列表：失败时沿用已有的本地数据
    const projects = (await fetchProjects()) ?? get().projects;
    let activeId: string | null = loadLocalActiveId();
    if (projects.length > 0) {
      const validId = activeId && projects.find((p) => p.id === activeId) ? activeId : projects[0].id;
      activeId = validId;
    }
    set({ projects, activeProjectId: activeId });
  },
}));
