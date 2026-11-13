/**
 * 无所有者边界：画布未加载（getCanvasProjectId() === null）时，
 * dirty 不得触发离开确认，也不得派发保存请求。
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
}));

vi.mock("@/features/canvas/persistence/project-transport", () => ({
  saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  saveProjectDeltaRaw: vi.fn(),
}));

vi.mock("@/entities/project", () => ({
  getProjectRevision: () => 1,
  updateProjectRevision: vi.fn(),
  runProjectWrite: <T,>(fn: () => Promise<T>) => fn(),
}));

vi.mock("@/features/canvas/session/session-expired-store", () => ({
  useSessionExpiredStore: {
    getState: () => ({ markExpired: vi.fn(), resetExpired: vi.fn() }),
  },
}));

vi.mock("@/lib/api/error-message", () => ({
  parseErrorBody: () => null,
}));

vi.mock("@/features/canvas/stores/canvas-document-store", () => ({
  getCanvasProjectId: () => null,
  getCanvasAgentModel: () => undefined,
  takeCanvasSnapshot: () => ({
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    minimapVisible: true,
    snapEnabled: false,
  }),
}));

import { saveManager } from "@/features/canvas/persistence/save-manager";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  saveManager.resetForProjectSwitch();
  saveManager.setUnloadPromptEligible(true);
});

afterEach(() => {
  saveManager.setUnloadPromptEligible(false);
  saveManager.resetForProjectSwitch();
  vi.useRealTimers();
});

describe("SaveManager 无所有者", () => {
  it("dirty 不弹离开确认，也不派发保存", () => {
    saveManager.markDirty();

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);

    expect(unload.defaultPrevented).toBe(false);
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();

    // 防抖定时器到点后 save() 仍因无所有者早退，不会误发请求
    vi.advanceTimersByTime(30_000);
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect(saveManager.getSavePhase()).toBe("unknown");
  });
});
