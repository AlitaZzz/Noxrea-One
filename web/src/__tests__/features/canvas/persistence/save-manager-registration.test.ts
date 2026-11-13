// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  saveProjectDeltaRaw: vi.fn(),
}));

vi.mock("@/features/canvas/persistence/project-transport", () => ({
  saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  saveProjectDeltaRaw: (...args: unknown[]) => mocks.saveProjectDeltaRaw(...args),
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

interface SaveManagerInternals {
  registered: boolean;
  offline: boolean;
}

type RegistrationModules = {
  saveManager: (typeof import("@/features/canvas/persistence/save-manager"))["saveManager"];
  useCanvasStore: (typeof import("@/features/canvas/stores/canvas-store"))["useCanvasStore"];
};

let app: RegistrationModules;

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

function restoreProject(): void {
  app.useCanvasStore.getState().restoreFromProject("p1", {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    minimapVisible: true,
    snapEnabled: false,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const { saveManager } = await import("@/features/canvas/persistence/save-manager");
  const { useCanvasStore } = await import("@/features/canvas/stores/canvas-store");
  app = { saveManager, useCanvasStore };
});

afterEach(() => {
  app.saveManager.resetForProjectSwitch();
});

describe("SaveManager lifecycle registration", () => {
  it("registers when the baseline is established and samples navigator.onLine", () => {
    setOnline(true);
    restoreProject();

    const internals = app.saveManager as unknown as SaveManagerInternals;
    expect(internals.registered).toBe(false);

    // 注册前的事件不得影响状态；owner 已存在但基线未建立 → unknown
    window.dispatchEvent(new Event("offline"));
    expect(internals.offline).toBe(false);
    expect(app.saveManager.getSavePhase()).toBe("unknown");

    setOnline(false);
    app.saveManager.setBaselineFromCurrent("p1");

    expect(internals.registered).toBe(true);
    expect(internals.offline).toBe(true);
    expect(app.saveManager.getSavePhase()).toBe("offline");

    setOnline(true);
    window.dispatchEvent(new Event("online"));
    expect(app.saveManager.getSavePhase()).toBe("saved");
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect(mocks.saveProjectDeltaRaw).not.toHaveBeenCalled();
  });

  it("registers on the first setDirty before the baseline exists", () => {
    setOnline(false);
    restoreProject();

    const internals = app.saveManager as unknown as SaveManagerInternals;
    expect(internals.registered).toBe(false);

    app.saveManager.markDirty();

    expect(internals.registered).toBe(true);
    expect(internals.offline).toBe(true);
    // 离线优先于 unsaved；基线尚未建立也不能把内容伪装成 saved
    expect(app.saveManager.getSavePhase()).toBe("offline");
  });
});
