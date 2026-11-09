/**
 * 项目领域命令。
 * 组件不直接触达 store：命令是唯一的写入口，返回与 store 动作一致的业务结果。
 */
import { useProjectStore } from "./store";
import type { ProjectSummary } from "./types";

export function refreshProjects(): Promise<void> {
  return useProjectStore.getState().refreshProjects();
}

export function createProject(name?: string): Promise<ProjectSummary | null> {
  return useProjectStore.getState().createProject(name);
}

export function renameProject(id: string, name: string): void {
  useProjectStore.getState().renameProject(id, name);
}

export function updateCover(id: string, coverKey: string | null): void {
  useProjectStore.getState().updateCover(id, coverKey);
}

export function deleteProject(id: string): Promise<boolean> {
  return useProjectStore.getState().deleteProject(id);
}

export function updateProjectRevision(id: string, revision: number): void {
  useProjectStore.getState().updateProjectRevision(id, revision);
}

/** 写入内存会话标记；项目身份的唯一真相源仍是 URL。 */
export function activateProject(id: string): void {
  useProjectStore.getState().activateProject(id);
}

/** 采纳握手摘要：列表可能为空，顶栏名称与 revision 依赖此摘要。 */
export function upsertProjectSummary(summary: ProjectSummary): void {
  useProjectStore.getState().upsertProjectSummary(summary);
}
