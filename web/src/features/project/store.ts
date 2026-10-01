/**
 * 画布项目状态仓库。
 * 管理项目摘要列表（不含画布内容）与当前激活项目（内存会话标记），
 * 负责项目的增删改查；画布内容的持久化由 SaveManager 单独负责。
 *
 * 边界约定：
 *  - projects 只存摘要（ProjectSummary）：列表页渲染 + 保存链路的 revision 账本。
 *    画布内容从不落进本 store（restoreFromProject 直达 canvas-store），
 *    列表缩略图 / 节点数由服务端列表投影提供。
 *  - activeProjectId 是纯内存的画布会话标记（画布页从 URL 写入），
 *    项目身份的唯一真相源是 URL，不做本地持久化记忆。
 */
import { create } from "zustand";

import type { AnyEdge, BackgroundType, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";
import { projectApi } from "@/features/project/api";
import { saveMutex } from "@/features/project/save-mutex";
import type { CanvasProject, ProjectSummary } from "@/features/project/types";
import { ApiError } from "@/lib/api/client";
import { resolveApiError } from "@/lib/api/error-message";
import { DEFAULT_BACKGROUND, DEFAULT_VIEWPORT } from "@/lib/constants";
import { showGlobalNotification } from "@/lib/global-notification";
import { captureSession, onSessionChange, SessionChangedError } from "@/lib/session-lifecycle";
import { isOffline } from "@/lib/utils/upload";

// ===== API helpers =====

// 服务端返回的 canvasData 是未验证 JSON，按宽松投影解析（读侧，字段全可选）；
// 前端提交侧的严格快照类型见 types.ts 的 CanvasData，两者描述同一 wire 格式。
interface CanvasData {
  viewport?: ViewportState;
  background?: BackgroundType;
  minimapVisible?: boolean;
  snapToGrid?: boolean;
  agentModel?: string;
  nodes?: unknown[];
  edges?: unknown[];
}

interface ServerProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  thumbnail: string | null;
  coverUrl: string | null;
  nodeCount: number;
}

interface ServerProjectDetail {
  id: string;
  name: string;
  revision?: number;
  coverUrl?: string | null;
  canvasData?: CanvasData;
  updatedAt: string;
}

function toTimestamp(updatedAt: string): number {
  const ts = new Date(updatedAt).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
}

function mapServerSummary(p: ServerProjectSummary): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    updatedAt: toTimestamp(p.updatedAt),
    thumbnail: p.thumbnail ?? undefined,
    coverUrl: p.coverUrl ?? undefined,
    nodeCount: p.nodeCount,
  };
}

/** 首个带 src 的图片节点（与服务端 project-summary 投影同一取法） */
function firstImageSrc(nodes: AnyNode[]): string | undefined {
  for (const node of nodes) {
    if (node?.type === "image-node") {
      const src = (node.data as { src?: unknown } | undefined)?.src;
      if (typeof src === "string" && src) return src;
    }
  }
  return undefined;
}

function mapServerDetail(p: ServerProjectDetail): CanvasProject {
  const nodes = (p.canvasData?.nodes || []) as AnyNode[];
  const coverUrl = p.coverUrl ?? undefined;
  return {
    id: p.id,
    name: p.name,
    revision: p.revision ?? 1,
    updatedAt: toTimestamp(p.updatedAt),
    thumbnail: coverUrl ?? firstImageSrc(nodes),
    coverUrl,
    nodeCount: nodes.length,
    viewport: p.canvasData?.viewport || DEFAULT_VIEWPORT,
    background: p.canvasData?.background || DEFAULT_BACKGROUND,
    minimapVisible: p.canvasData?.minimapVisible ?? true,
    snapToGrid: p.canvasData?.snapToGrid || false,
    agentModel: p.canvasData?.agentModel,
    nodes,
    edges: (p.canvasData?.edges || []) as AnyEdge[],
  };
}

/** 摘要化（upsert 进列表用）：detail 已带全部摘要字段 */
function toSummary(p: CanvasProject): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    updatedAt: p.updatedAt,
    thumbnail: p.thumbnail,
    coverUrl: p.coverUrl,
    nodeCount: p.nodeCount,
  };
}

/**
 * 拉取项目摘要列表。
 * 返回 null 表示「请求失败」（离线 / 5xx / 业务码非 200），与「成功但为空」区分开：
 * 调用方据此保留本地数据，避免短暂断网被误判成「项目全部丢失」。
 */
async function fetchProjects(): Promise<ProjectSummary[] | null> {
  try {
    const data = await projectApi.listProjects<ServerProjectSummary[]>();
    return Array.isArray(data) ? data.map(mapServerSummary) : null;
  } catch { /* offline or error */ }
  return null;
}

async function apiCreateProject(name: string): Promise<CanvasProject | null> {
  try {
    const data = await projectApi.createProject<ServerProjectDetail>(name, { viewport: DEFAULT_VIEWPORT, background: DEFAULT_BACKGROUND, nodes: [], edges: [] });
    if (data) return mapServerDetail(data);
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
  projects: ProjectSummary[];
  activeProjectId: string | null;

  activeProject: () => ProjectSummary | undefined;
  adoptProject: (payload: unknown) => CanvasProject | null;
  createProject: (name?: string) => Promise<CanvasProject>;
  renameProject: (id: string, name: string) => void;
  updateCover: (id: string, coverUrl: string | null) => void;
  deleteProject: (id: string) => void;
  deleteProjects: (ids: string[]) => void;
  updateProjectRevision: (id: string, revision: number) => void;
  setActiveProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,

  activeProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId);
  },

  /**
   * 采纳 SSE 握手下发的服务端项目快照（原子握手的数据面）。
   * 映射为完整项目并 upsert 摘要进列表（直接经 URL 进画布时列表可能为空；
   * 画布顶栏的名称与保存链路的 revision 都从这里来），返回映射结果供
   * restoreFromProject 恢复画布。载荷不合法返回 null，调用方按连接失败收敛。
   */
  adoptProject: (payload) => {
    if (typeof payload !== "object" || payload === null) return null;
    const detail = payload as ServerProjectDetail;
    if (typeof detail.id !== "string" || detail.id.length === 0 || typeof detail.name !== "string") {
      return null;
    }
    const project = mapServerDetail(detail);
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects.map((p) => (p.id === project.id ? toSummary(project) : p))
        : [...s.projects, toSummary(project)],
    }));
    return project;
  },

  createProject: async (name) => {
    const session = captureSession();
    const count = get().projects.length;
    const projectName = name || `Project ${count + 1}`;
    const project = await session.run(() => apiCreateProject(projectName));
    session.assertCurrent();
    if (project) {
      set((s) => ({ projects: [...s.projects, toSummary(project)], activeProjectId: project.id }));
      return project;
    }
    throw new Error("Failed to create project");
  },

  renameProject: (id, name) => {
    const session = captureSession();
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
        const updated = await session.run(() => saveMutex.runExclusive(() =>
          session.run(() => projectApi.updateProject(id, { name })),
        ));
        session.assertCurrent();

        if (typeof updated?.revision === "number") {
          get().updateProjectRevision(id, updated.revision);
          return;
        }
        throw new Error(resolveApiError(null, undefined, "project.rename_failed"));
      } catch (e) {
        if (e instanceof SessionChangedError) return;
        if (prevName !== undefined) {
          set((s) => ({
            projects: s.projects.map((p) => (p.id === id ? { ...p, name: prevName } : p)),
          }));
        }
        notifyError(e instanceof ApiError ? e.message : resolveApiError(null, undefined, "project.rename_failed"));
      }
    })();
  },

  updateCover: (id, coverUrl) => {
    const session = captureSession();
    if (rejectOffline()) return;
    const prev = get().projects.find((p) => p.id === id);
    // 乐观更新，失败回滚；封面是纯元数据（同改名：不参与版本判定）
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, coverUrl: coverUrl ?? undefined, thumbnail: coverUrl ?? undefined } : p
      ),
    }));
    void (async () => {
      try {
        const updated = await session.run(() => saveMutex.runExclusive(() =>
          session.run(() => projectApi.updateProject(id, { coverUrl })),
        ));
        session.assertCurrent();
        if (typeof updated?.revision === "number") {
          get().updateProjectRevision(id, updated.revision);
          return;
        }
        throw new Error(resolveApiError(null, undefined, "project.cover_failed"));
      } catch (e) {
        if (e instanceof SessionChangedError) return;
        if (prev) {
          set((s) => ({
            projects: s.projects.map((p) =>
              p.id === id ? { ...p, coverUrl: prev.coverUrl, thumbnail: prev.thumbnail } : p
            ),
          }));
        }
        notifyError(e instanceof ApiError ? e.message : resolveApiError(null, undefined, "project.cover_failed"));
      }
    })();
  },

  deleteProject: (id) => {
    const session = captureSession();
    if (rejectOffline()) return;
    // 失败回滚用：删除是破坏性操作，不能「假删成功」
    const snapshot = get().projects;
    const snapshotActiveId = get().activeProjectId;
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      // 激活项目被删：会话标记指向删除后列表的首项（画布页此刻未挂载，无导航联动）
      activeProjectId: s.activeProjectId === id
        ? (s.projects.find((p) => p.id !== id)?.id ?? null)
        : s.activeProjectId,
    }));
    void (async () => {
      const { ok, message } = await apiDeleteProject(id);
      if (session.signal.aborted) return;
      if (ok) return;
      notifyError(message ?? resolveApiError(null, undefined, "project.delete_failed"));
      set({ projects: snapshot, activeProjectId: snapshotActiveId });
    })();
  },

  deleteProjects: (ids) => {
    const session = captureSession();
    if (rejectOffline()) return;
    const snapshot = get().projects;
    const snapshotActiveId = get().activeProjectId;
    const idSet = new Set(ids);
    set((s) => {
      const projects = s.projects.filter((p) => !idSet.has(p.id));
      const activeProjectId = s.activeProjectId && idSet.has(s.activeProjectId)
        ? (projects[0]?.id ?? null)
        : s.activeProjectId;
      return { projects, activeProjectId };
    });
    void (async () => {
      const results = await Promise.all(ids.map((id) => apiDeleteProject(id)));
      if (session.signal.aborted) return;
      const failedIds = new Set(ids.filter((_, i) => !results[i].ok));
      if (failedIds.size === 0) return;
      notifyError(results.find((r) => !r.ok)?.message ?? resolveApiError(null, undefined, "project.delete_failed"));
      // 只把删除失败的项放回列表：成功删除的在服务端已不存在，
      // 整表回滚会让它们变成「刷新才消失」的幽灵项目
      const restored = snapshot.filter((p) => failedIds.has(p.id));
      set((s) => {
        const keptIds = new Set(s.projects.map((p) => p.id));
        const projects = [...s.projects, ...restored.filter((p) => !keptIds.has(p.id))];
        const activeProjectId = projects.some((p) => p.id === snapshotActiveId) ? snapshotActiveId : (projects[0]?.id ?? null);
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
  },

  refreshProjects: async () => {
    const session = captureSession();
    const projects = await fetchProjects();
    if (session.signal.aborted) return;
    // 拉取失败：保留现有列表，宁可展示过期数据也不能清空
    // （空列表会让用户以为项目被删）
    if (!projects) return;
    set({ projects });
  },
}));

onSessionChange(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null });
});
