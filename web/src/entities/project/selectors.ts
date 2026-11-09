/**
 * 项目领域读取接口。
 * 只暴露渲染与保存链路所需的薄选择器；store 与内部状态形状不对外。
 */
import { useProjectStore } from "./store";
import type { ProjectSummary } from "./types";

export function useProjects(): ProjectSummary[] {
  return useProjectStore((state) => state.projects);
}

export function useActiveProjectId(): string | null {
  return useProjectStore((state) => state.activeProjectId);
}

/** 当前激活项目的摘要；列表无此项目时为 undefined。 */
export function useActiveProjectSummary(): ProjectSummary | undefined {
  return useProjectStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  );
}

/**
 * 同步读取项目 revision；列表无此项目时返回 null。
 * 保存链路据此折算初始 revision 1，禁止把 null 写进请求。
 */
export function getProjectRevision(id: string): number | null {
  return useProjectStore.getState().projects.find((project) => project.id === id)?.revision ?? null;
}
