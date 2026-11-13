// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCanvasLease, setCanvasLease } from "@/features/canvas/persistence/canvas-lease";
import { saveManager } from "@/features/canvas/persistence/save-manager";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  revision: 1,
}));

vi.mock("@/features/canvas/persistence/project-transport", () => ({
  saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  saveProjectDeltaRaw: vi.fn(),
}));

vi.mock("@/entities/project", () => ({
  getProjectRevision: () => mocks.revision,
  updateProjectRevision: (_id: string, revision: number) => { mocks.revision = revision; },
  runProjectWrite: <T,>(fn: () => Promise<T>) => fn(),
}));

vi.mock("@/features/canvas/session/session-expired-store", () => ({
  useSessionExpiredStore: {
    getState: () => ({
      markExpired: vi.fn(),
      resetExpired: vi.fn(),
    }),
  },
}));

vi.mock("@/lib/api/error-message", () => ({
  parseErrorBody: () => null,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.revision = 1;
  mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
  saveManager.resetForProjectSwitch();
  saveManager.setUnloadPromptEligible(false);
  setCanvasLease("p1", 1);
  useCanvasStore.getState().restoreFromProject("p1", {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    minimapVisible: true,
    snapEnabled: false,
  });
  // 用公开基线建立确保监听器每例都已注册，再以 online 事件复位离线标志；
  // 不直接改私有字段，也不依赖文件内首个用例的注册副作用。
  saveManager.setBaselineFromCurrent("p1");
  window.dispatchEvent(new Event("online"));
  saveManager.resetForProjectSwitch();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  saveManager.setUnloadPromptEligible(false);
  saveManager.resetForProjectSwitch();
  clearCanvasLease("p1");
  vi.useRealTimers();
});

describe("SaveManager page lifecycle", () => {
  it("continues saving after a beforeunload event that does not unload the page", async () => {
    saveManager.setUnloadPromptEligible(true);
    saveManager.markDirty();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));
    expect(mocks.saveProjectRaw.mock.calls[0][2]).toBe(true);
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("saved"));

    // 内容已落库：不再弹离开确认
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    saveManager.markDirty();
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2));

    expect(mocks.saveProjectRaw.mock.calls[1][2]).toBe(false);
  });

  it("does not prompt outside the canvas route but still flushes", async () => {
    saveManager.setUnloadPromptEligible(false);
    saveManager.markDirty();

    const inactive = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(inactive);
    expect(inactive.defaultPrevented).toBe(false);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("saved"));

    saveManager.setUnloadPromptEligible(true);
    saveManager.markDirty();
    const active = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(active);
    expect(active.defaultPrevented).toBe(true);
  });

  it("prompts while a save is in flight and never sends a second unload request", async () => {
    saveManager.setUnloadPromptEligible(true);
    let resolveSave!: (value: { ok: boolean; status: number }) => void;
    mocks.saveProjectRaw.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    saveManager.markDirty();
    const first = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);

    // 在途保存属于当前 owner：仍然弹确认，且 keepalive 兜底不得并发第二个写请求
    const second = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);

    resolveSave({ ok: true, status: 200 });
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("saved"));

    const third = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(third);
    expect(third.defaultPrevented).toBe(false);
  });

  it("does not prompt when offline with no unsaved changes", () => {
    saveManager.setUnloadPromptEligible(true);
    saveManager.setBaselineFromCurrent("p1");
    window.dispatchEvent(new Event("offline"));
    expect(saveManager.getSavePhase()).toBe("offline");

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);

    expect(unload.defaultPrevented).toBe(false);
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
  });

  it("never sends a keepalive save on pagehide while a save is in flight", async () => {
    saveManager.setUnloadPromptEligible(true);
    let resolveSave!: (value: { ok: boolean; status: number }) => void;
    mocks.saveProjectRaw.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    saveManager.markDirty();
    saveManager.flushOnHide();
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));

    // 在途期间继续编辑：dirty 与 saving 同时成立，pagehide 的 keepalive 分支必须直接返回
    saveManager.markDirty();
    const pagehide = new Event("pagehide", { cancelable: true });
    window.dispatchEvent(pagehide);

    expect(pagehide.defaultPrevented).toBe(false);
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);

    resolveSave({ ok: true, status: 200 });
    await Promise.resolve();
  });

  it("prompts for unsaved changes while a 401 pauses saving", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveManager.setUnloadPromptEligible(true);
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    saveManager.flushOnHide();
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("blocked"));

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    warnSpy.mockRestore();
  });

  it("prompts for unsaved changes while offline", () => {
    saveManager.setUnloadPromptEligible(true);
    saveManager.markDirty();
    window.dispatchEvent(new Event("offline"));
    expect(saveManager.getSavePhase()).toBe("offline");

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it("does not prompt after the editor lease has expired", async () => {
    saveManager.setUnloadPromptEligible(true);
    mocks.saveProjectRaw.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "canvas_revision_conflict" }),
    });

    saveManager.markDirty();
    saveManager.flushOnHide();
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("expired"));

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("never prompts on visibilitychange or pagehide", () => {
    saveManager.setUnloadPromptEligible(true);
    saveManager.markDirty();

    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    const visibility = new Event("visibilitychange", { cancelable: true });
    document.dispatchEvent(visibility);
    expect(visibility.defaultPrevented).toBe(false);

    const pagehide = new Event("pagehide", { cancelable: true });
    window.dispatchEvent(pagehide);
    expect(pagehide.defaultPrevented).toBe(false);
  });

  it("keeps offline above a cleared 401 pause", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveProjectRaw.mockResolvedValueOnce({ ok: false, status: 401 });

    saveManager.markDirty();
    saveManager.flushOnHide();
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("blocked"));

    // 401 暂停优先级高于离线：断网不会覆盖登录失效提示
    window.dispatchEvent(new Event("offline"));
    expect(saveManager.getSavePhase()).toBe("blocked");

    // 同一租约握手解除 401 后，离线成为当前保存停用态
    saveManager.notifySessionValid("p1");
    expect(saveManager.getSavePhase()).toBe("offline");

    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(saveManager.getSavePhase()).toBe("saved"));
    warnSpy.mockRestore();
  });
});
