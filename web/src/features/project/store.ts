/**
 * 画布项目状态仓库。
 * 管理项目列表与当前激活项目（本地记忆 activeId），
 * 负责项目的增删改查以及画布数据的序列化保存与加载。
 */
import { create } from "zustand";

import type { AnyEdge, BackgroundType, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";
import { projectApi } from "@/features/project/api";
import { saveMutex } from "@/features/project/save-mutex";
import type { CanvasProject } from "@/features/project/types";
import { ApiError } from "@/lib/api/client";
import { resolveApiError } from "@/lib/api/error-message";
import { DEFAULT_BACKGROUND, DEFAULT_VIEWPORT } from "@/lib/constants";
import { showGlobalNotification } from "@/lib/global-notification";
import { isOffline } from "@/lib/utils/upload";

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
    updatedAt: new Date(p.updatedAt).getTime(),
    viewport: p.canvasData?.viewport || DEFAULT_VIEWPORT,
    background: p.canvasData?.background || DEFAULT_BACKGROUND,
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
    const data = await projectApi.listProjects<ServerProject[]>();
    return Array.isArray(data) ? data.map(mapServerProject) : null;
  } catch { /* offline or error */ }
  return null;
}

async function fetchProjectById(id: string): Promise<CanvasProject | null> {
  try {
    const data = await projectApi.getProject<ServerProject>(id);
    return data ? mapServerProject(data) : null;
  } catch { /* offline or error */ }
  return null;
}

async function apiCreateProject(name: string): Promise<CanvasProject | null> {
  try {
    const data = await projectApi.createProject<ServerProject>(name, { viewport: DEFAULT_VIEWPORT, background: DEFAULT_BACKGROUND, nodes: [], edges: [] });
    if (data) {
      return {
        id: String(data.id),
        name: data.name,
        revision: data.revision ?? 1,
        updatedAt: Date.now(),
        viewport: DEFAULT_VIEWPORT,
        background: DEFAULT_BACKGROUND,
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
    await projectApi.deleteProject(projectId);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof ApiError ? e.message : resolveApiError(null, undefined, "project.delete_failed"),
    };
  }
}

/** 失败提示（store 层统一负责，UI 无需各自处理） */
function notifyError(message: string) {
  showGlobalNotification().error({ title: message, placement: "bottomRight", duration: 6 });
}

/** 离线时写请求必败：直接提示，跳过乐观更新，避免「删了又闪回来」的回滚闪烁 */
function rejectOffline(): boolean {
  if (!isOffline()) return false;
  notifyError(resolveApiError(null, undefined, "network_unreachable"));
  return true;
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
  syncCanvasState: (id: string, nodes: unknown[], edges: unknown[], viewport: ViewportState, background: BackgroundType, minimapVisible?: boolean, snapToGrid?: boolean, agentModel?: string | null) => void;
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
    // upsert：刷新画布时本方法与 initialize（全量列表）并行请求，若列表尚未
    // 就绪，map 匹配不到会把刚拉到的项目整个丢掉，画布顶栏先闪一帧 Untitled
    set((s) => ({
      projects: s.projects.some((p) => p.id === id)
        ? s.projects.map((p) => (p.id === id ? fresh : p))
        : [...s.projects, fresh],
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
    if (rejectOffline()) return;
    const prevName = get().projects.find((p) => p.id === id)?.name;
    // 乐观更新，失败回滚：此前无论响应码如何都留在本地，刷新后名称又变回去
    set((s) => ({
      projects: s.projects.map((p) => p.id === id ? { ...p, name, updatedAt: Date.now() } : p),
    }));
    void (async () => {
      try {
        // 与画布保存共用同一条写互斥锁。改名是纯元数据：服务端不做版本校验也不递增
        // revision，因此不存在改名引发的版本冲突（409 只属于画布内容保存）。
        const updated = await saveMutex.runExclusive(() =>
          projectApi.updateProject(id, {
            name,
            baseRevision: get().projects.find((p) => p.id === id)?.revision ?? 1,
          }),
        );

        if (typeof updated?.revision === "number") {
          get().updateProjectRevision(id, updated.revision);
          return;
        }
        throw new Error(resolveApiError(null, undefined, "project.rename_failed"));
      } catch (e) {
        if (prevName !== undefined) {
          set((s) => ({
            projects: s.projects.map((p) => (p.id === id ? { ...p, name: prevName } : p)),
          }));
        }
        notifyError(e instanceof ApiError ? e.message : resolveApiError(null, undefined, "project.rename_failed"));
      }
    })();
  },

  deleteProject: (id) => {
    if (rejectOffline()) return;
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
      notifyError(message ?? resolveApiError(null, undefined, "project.delete_failed"));
      set({ projects: snapshot, activeProjectId: snapshotActiveId });
      saveLocalActiveId(snapshotActiveId);
    })();
  },

  deleteProjects: (ids) => {
    if (rejectOffline()) return;
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
      notifyError(results.find((r) => !r.ok)?.message ?? resolveApiError(null, undefined, "project.delete_failed"));
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
      projects: s.projects.map((p) => {
        if (p.id !== id) return p;
        // 单调保护：版本只许前进。迟到的保存成功回写（baseRevision + 1）可能
        // 晚于重命名等已推高版本的响应到达，放行会把版本开倒车、引发下次 409。
        return revision > p.revision ? { ...p, revision } : p;
      }),
    }));
  },

  setActiveProject: (id) => {
    set({ activeProjectId: id });
    saveLocalActiveId(id);
  },

  syncCanvasState: (id, nodes, edges, viewport, background, minimapVisible, snapToGrid, agentModel) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, nodes: nodes as AnyNode[], edges: edges as AnyEdge[], viewport, background, minimapVisible, snapToGrid, agentModel: agentModel ?? undefined, updatedAt: Date.now() } : p
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
