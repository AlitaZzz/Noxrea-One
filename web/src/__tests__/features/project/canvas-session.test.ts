/**
 * 画布编辑会话事件处理测试。
 * evict：立即进入过期态并同步服务端 revision，联动停用保存；
 * sync：仅在服务端 revision 更新时收敛过期（断线期间错过的变更），
 *   项目尚未加载时忽略（首次加载的内容本就取自服务端最新快照）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionExpiredStore } from "@/features/project/session-expired-store";
import { useProjectStore } from "@/features/project/store";
import { handleCanvasSessionEvent } from "@/features/project/use-canvas-session";

const mocks = vi.hoisted(() => ({
  notifyEvicted: vi.fn(),
}));

vi.mock("@/features/project/save-manager", async () => {
  // 模拟真实联动链：notifyEvicted 内部会停用保存并置会话过期态，
  // 否则 mock 掉 saveManager 后 expired 无处置位
  const { useSessionExpiredStore } = await import("@/features/project/session-expired-store");
  return {
    saveManager: {
      notifyEvicted: () => {
        mocks.notifyEvicted();
        useSessionExpiredStore.getState().markExpired();
      },
    },
  };
});

beforeEach(() => {
  mocks.notifyEvicted.mockClear();
  useSessionExpiredStore.setState({ expired: false });
  useProjectStore.setState({
    projects: [{ id: "p1", revision: 2 } as never],
  });
});

describe("handleCanvasSessionEvent", () => {
  it("evict：进入过期态，本地 revision 同步到服务端版本，联动停用保存", () => {
    handleCanvasSessionEvent("p1", "evict", { revision: 5 });
    expect(useSessionExpiredStore.getState().expired).toBe(true);
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.revision).toBe(5);
    expect(mocks.notifyEvicted).toHaveBeenCalledWith();
  });

  it("evict：无 revision 载荷也进入过期态", () => {
    handleCanvasSessionEvent("p1", "evict", {});
    expect(useSessionExpiredStore.getState().expired).toBe(true);
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.revision).toBe(2);
    expect(mocks.notifyEvicted).toHaveBeenCalledWith();
  });

  it("sync：服务端 revision 更新时收敛过期（断线期间错过的变更）并联动停用保存", () => {
    handleCanvasSessionEvent("p1", "sync", { revision: 3 });
    expect(useSessionExpiredStore.getState().expired).toBe(true);
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.revision).toBe(3);
    expect(mocks.notifyEvicted).toHaveBeenCalledWith();
  });

  it("sync：服务端 revision 与本地一致时无副作用", () => {
    handleCanvasSessionEvent("p1", "sync", { revision: 2 });
    expect(useSessionExpiredStore.getState().expired).toBe(false);
    expect(mocks.notifyEvicted).not.toHaveBeenCalled();
  });

  it("sync：服务端 revision 更旧（store 单调保护）不进入过期态", () => {
    handleCanvasSessionEvent("p1", "sync", { revision: 1 });
    expect(useSessionExpiredStore.getState().expired).toBe(false);
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.revision).toBe(2);
    expect(mocks.notifyEvicted).not.toHaveBeenCalled();
  });

  it("sync：项目尚未加载（不在 store）时忽略，不误判过期", () => {
    // 直接打开 / 刷新画布页：SSE sync 帧可能先于项目数据到达 store，
    // 此时无法判定落后，必须忽略，否则 revision > 0 恒真会把刚打开的页面锁进过期弹窗
    useProjectStore.setState({ projects: [] });
    handleCanvasSessionEvent("p1", "sync", { revision: 9 });
    expect(useSessionExpiredStore.getState().expired).toBe(false);
    expect(mocks.notifyEvicted).not.toHaveBeenCalled();
  });

  it("未知事件名与陈旧事件（前面的 event 行未被 data 覆盖）不误触发", () => {
    handleCanvasSessionEvent("p1", "", { revision: 9 });
    expect(useSessionExpiredStore.getState().expired).toBe(false);
    expect(mocks.notifyEvicted).not.toHaveBeenCalled();
  });

  it("revision 载荷非数字时 evict 仍进入过期态（容错）", () => {
    handleCanvasSessionEvent("p1", "evict", { revision: "9" as unknown as number });
    expect(useSessionExpiredStore.getState().expired).toBe(true);
    expect(mocks.notifyEvicted).toHaveBeenCalledWith();
  });
});
