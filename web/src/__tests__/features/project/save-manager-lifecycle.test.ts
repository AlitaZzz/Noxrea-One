// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { resetCanvasLease, setCanvasLease } from "@/features/project/canvas-lease";
import { saveManager } from "@/features/project/save-manager";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  revision: 1,
}));

vi.mock("@/features/project/api", () => ({
  projectApi: { saveProjectRaw: mocks.saveProjectRaw },
}));

vi.mock("@/features/project/store", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "p1", revision: mocks.revision }],
      updateProjectRevision: (_id: string, revision: number) => { mocks.revision = revision; },
    }),
  },
}));

vi.mock("@/features/project/session-expired-store", () => ({
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
  resetCanvasLease();
  setCanvasLease("p1", 1);
  useCanvasStore.getState().restoreFromProject("p1", {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    minimapVisible: true,
    snapToGrid: false,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  saveManager.resetForProjectSwitch();
  resetCanvasLease();
  vi.useRealTimers();
});

describe("SaveManager page lifecycle", () => {
  it("continues saving after a beforeunload event that does not unload the page", async () => {
    saveManager.markDirty();
    window.dispatchEvent(new Event("beforeunload"));
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));
    expect(mocks.saveProjectRaw.mock.calls[0][2]).toBe(true);

    saveManager.markDirty();
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2));

    expect(mocks.saveProjectRaw.mock.calls[1][2]).toBe(false);
  });
});
