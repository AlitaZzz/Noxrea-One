/**
 * 项目 store 写操作回归测试：删除失败时本地状态必须回到正确形态。
 *
 * 覆盖：
 *   - 删除失败 → 项目回到列表
 *   - 批量删除部分失败 → 只恢复失败项（成功的已真的删除，整表回滚会产生幽灵项目）
 *   - 拉取列表失败 → 保留现有列表，不清空
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  listProjects: vi.fn(),
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/features/project/api", () => ({
  projectApi: {
    deleteProject: (...args: unknown[]) => mocks.deleteProject(...args),
    listProjects: (...args: unknown[]) => mocks.listProjects(...args),
    getProject: vi.fn(async () => ({ code: 200, data: null, msg: "" })),
    createProject: vi.fn(async () => ({ code: 200, data: null, msg: "" })),
    updateProject: vi.fn(async () => ({ code: 200, data: null, msg: "" })),
    saveProjectRaw: vi.fn(async () => new Response(null, { status: 200 })),
  },
}));

vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => mocks.notify,
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { useProjectStore } from "@/features/project/store";

const seed = () => {
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "A", createdAt: 0, updatedAt: 0, viewport: { x: 0, y: 0, zoom: 1 }, background: "dots", theme: "dark", minimapVisible: true, snapToGrid: false, nodes: [], edges: [] },
      { id: "p2", name: "B", createdAt: 0, updatedAt: 0, viewport: { x: 0, y: 0, zoom: 1 }, background: "dots", theme: "dark", minimapVisible: true, snapToGrid: false, nodes: [], edges: [] },
      { id: "p3", name: "C", createdAt: 0, updatedAt: 0, viewport: { x: 0, y: 0, zoom: 1 }, background: "dots", theme: "dark", minimapVisible: true, snapToGrid: false, nodes: [], edges: [] },
    ],
    activeProjectId: "p1",
  });
};

const okRes = { code: 200, data: null, msg: "" };
const failRes = { code: 500, data: null, msg: "服务内部错误" };

describe("project store 删除与列表", () => {
  beforeEach(() => {
    mocks.deleteProject.mockReset();
    mocks.listProjects.mockReset();
    mocks.notify.error.mockReset();
    seed();
  });

  it("删除失败时把项目放回列表", async () => {
    mocks.deleteProject.mockResolvedValue(failRes);

    useProjectStore.getState().deleteProject("p1");
    await vi.waitFor(() => expect(mocks.notify.error).toHaveBeenCalled());

    await vi.waitFor(() => {
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    });
    expect(useProjectStore.getState().activeProjectId).toBe("p1");
  });

  it("删除成功时移除该项目", async () => {
    mocks.deleteProject.mockResolvedValue(okRes);

    useProjectStore.getState().deleteProject("p1");
    await vi.waitFor(() => {
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p2", "p3"]);
    });
    expect(mocks.notify.error).not.toHaveBeenCalled();
  });

  it("批量删除部分失败时只恢复失败项", async () => {
    mocks.deleteProject
      .mockResolvedValueOnce(okRes)   // p1 成功
      .mockResolvedValueOnce(failRes); // p2 失败

    useProjectStore.getState().deleteProjects(["p1", "p2"]);
    await vi.waitFor(() => expect(mocks.notify.error).toHaveBeenCalled());

    await vi.waitFor(() => {
      const ids = useProjectStore.getState().projects.map((p) => p.id);
      // p2 回到列表，p1 保持删除（否则会出现刷新才消失的幽灵项目）
      expect(ids).toContain("p2");
      expect(ids).not.toContain("p1");
      expect(ids).toContain("p3");
    });
  });

  it("拉取列表失败时保留现有列表", async () => {
    mocks.listProjects.mockResolvedValue(failRes);

    await useProjectStore.getState().refreshProjects();

    expect(useProjectStore.getState().projects).toHaveLength(3);
    expect(useProjectStore.getState().activeProjectId).toBe("p1");
  });

  it("拉取列表成功且为空时才清空", async () => {
    mocks.listProjects.mockResolvedValue({ code: 200, data: [], msg: "" });

    await useProjectStore.getState().refreshProjects();

    expect(useProjectStore.getState().projects).toHaveLength(0);
  });
});
