/**
 * 项目摘要状态仓库。
 * 只管理项目摘要列表（不含画布内容）、当前激活项目（内存会话标记）与项目命令；
 * 画布文档的会话、保存编排与内容持久化由 `features/canvas` 负责。
 *
 * 边界约定：
 *  - projects 只存摘要（ProjectSummary）：列表页渲染 + 保存链路的 revision 账本。
 *  - activeProjectId 是纯内存的画布会话标记（画布页从 URL 写入），
 *    项目身份的唯一真相源是 URL，不做本地持久化记忆。
 */
import { create } from "zustand";

import { ApiError } from "@/lib/api/client";
import { resolveApiError } from "@/lib/api/error-message";
import { showGlobalNotification } from "@/lib/global-notification";
import { captureSession, onSessionChange, SessionChangedError } from "@/lib/session-lifecycle";
import { isOffline } from "@/lib/utils/upload";

import * as projectApi from "./api";
import { runProjectWrite } from "./save-mutex";
import { toProjectSummary } from "./summary";
import type { ProjectSummary } from "./types";

interface ServerProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  thumbnail: string | null;
  coverKey: string | null;
  nodeCount: number;
}

interface ServerProjectDetail {
  id: string;
  name: string;
  revision?: number;
  coverKey?: string | null;
  thumbnailSrc?: string | null;
  nodeCount?: number;
  updatedAt?: string;
}

/**
 * 拉取项目摘要列表。
 * 返回 null 表示「请求失败」（离线 / 5xx / 业务码非 200），与「成功但为空」区分开：
 * 调用方据此保留本地数据，避免短暂断网被误判成「项目全部丢失」。
 */
async function fetchProjects(): Promise<ProjectSummary[] | null> {
  try {
    const data = await projectApi.listProjects<ServerProjectSummary[]>();
    return Array.isArray(data) ? data.map(toProjectSummary) : null;
  } catch { /* offline or error */ }
  return null;
}

interface CreateProjectResult {
  project: ProjectSummary | null;
  message?: string;
}

async function apiCreateProject(name: string): Promise<CreateProjectResult> {
  try {
    const data = await projectApi.createProject<ServerProjectDetail>(name);
    if (data) return { project: toProjectSummary(data) };
    return { project: null };
  } catch (e) {
    return {
      project: null,
      message: e instanceof ApiError ? e.message : resolveApiError(null, undefined, "project.create_failed"),
    };
  }
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

interface ProjectState {
  projects: ProjectSummary[];
  activeProjectId: string | null;

  refreshProjects: () => Promise<void>;
  createProject: (name?: string) => Promise<ProjectSummary | null>;
  renameProject: (id: string, name: string) => void;
  updateCover: (id: string, coverKey: string | null) => void;
  deleteProject: (id: string) => Promise<boolean>;
  updateProjectRevision: (id: string, revision: number) => void;
  activateProject: (id: string) => void;
  upsertProjectSummary: (summary: ProjectSummary) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => {
  /**
   * 项目纯元数据（名称 / 封面）的乐观更新骨架：本地先落值 → 写互斥锁内提交 →
   * 回写服务端 revision；失败按会话有效性回滚并提示。
   * 服务端对纯元数据不做版本校验也不递增 revision，因此不存在 409 分支。
   */
  const updateMetadata = <TPrev,>({
    id,
    prev,
    patch,
    optimistic,
    rollback,
    errorKey,
  }: {
    id: string;
    prev: TPrev | undefined;
    patch: Record<string, unknown>;
    optimistic: (project: ProjectSummary) => ProjectSummary;
    rollback: (project: ProjectSummary, prev: TPrev) => ProjectSummary;
    errorKey: string;
  }): void => {
    const session = captureSession();
    if (rejectOffline()) return;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? optimistic(p) : p)),
    }));
    void (async () => {
      try {
        // 与画布保存共用同一条写互斥锁。
        const updated = await session.run(() => runProjectWrite(() => {
          // 排队取得写锁后重新校验会话：等待期间可能已切换账号，
          // 不能再以旧会话发出请求；结果的后置校验仍由外层 session.run 负责。
          session.assertCurrent();
          return projectApi.updateProject(id, patch);
        }));

        if (typeof updated?.revision === "number") {
          get().updateProjectRevision(id, updated.revision);
          return;
        }
        throw new Error(resolveApiError(null, undefined, errorKey));
      } catch (e) {
        if (e instanceof SessionChangedError) return;
        if (prev !== undefined) {
          set((s) => ({
            projects: s.projects.map((p) => (p.id === id ? rollback(p, prev) : p)),
          }));
        }
        notifyError(e instanceof ApiError ? e.message : resolveApiError(null, undefined, errorKey));
      }
    })();
  };

  return {
    projects: [],
    activeProjectId: null,

    refreshProjects: async () => {
      const session = captureSession();
      const projects = await fetchProjects();
      if (session.signal.aborted) return;
      // 拉取失败：保留现有列表，宁可展示过期数据也不能清空
      // （空列表会让用户以为项目被删）
      if (!projects) return;
      set({ projects });
    },

    createProject: async (name) => {
      const session = captureSession();
      if (rejectOffline()) return null;
      const count = get().projects.length;
      const projectName = name || `Project ${count + 1}`;
      const { project, message } = await apiCreateProject(projectName);
      // 会话已切换：丢弃旧会话的响应，不提示也不写列表
      if (session.signal.aborted) return null;
      if (!project) {
        notifyError(message ?? resolveApiError(null, undefined, "project.create_failed"));
        return null;
      }
      set((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
      return project;
    },

    renameProject: (id, name) => {
      updateMetadata({
        id,
        prev: get().projects.find((p) => p.id === id),
        patch: { name },
        optimistic: (p) => ({ ...p, name, updatedAt: Date.now() }),
        rollback: (p, prevProject) =>
          prevProject
            ? { ...p, name: prevProject.name, updatedAt: prevProject.updatedAt }
            : p,
        errorKey: "project.rename_failed",
      });
    },

    updateCover: (id, coverKey) => {
      updateMetadata({
        id,
        prev: get().projects.find((p) => p.id === id),
        patch: { coverKey },
        optimistic: (p) => ({ ...p, coverKey: coverKey ?? undefined, thumbnail: coverKey ?? undefined }),
        rollback: (p, prev) => ({ ...p, coverKey: prev.coverKey, thumbnail: prev.thumbnail }),
        errorKey: "project.cover_failed",
      });
    },

    deleteProject: async (id) => {
      const session = captureSession();
      if (rejectOffline()) return false;
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
      const { ok, message } = await apiDeleteProject(id);
      if (session.signal.aborted) return false;
      if (ok) return true;
      notifyError(message ?? resolveApiError(null, undefined, "project.delete_failed"));
      set({ projects: snapshot, activeProjectId: snapshotActiveId });
      return false;
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

    activateProject: (id) => {
      set({ activeProjectId: id });
    },

    /**
     * 采纳握手摘要：SSE 首帧的权威项目摘要同步进列表（直接经 URL 进画布时
     * 列表可能为空；顶栏名称与保存链路的 revision 都从这里来）。
     */
    upsertProjectSummary: (summary) => {
      set((s) => ({
        projects: s.projects.some((p) => p.id === summary.id)
          ? s.projects.map((p) => (p.id === summary.id ? summary : p))
          : [...s.projects, summary],
      }));
    },
  };
});

onSessionChange(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null });
});
