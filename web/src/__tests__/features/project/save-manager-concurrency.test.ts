/**
 * SaveManager 并发保存回归测试。
 *
 * 覆盖此前会导致「项目切换卡死 / 保存不完整」的竞态：
 *   - 保存进行中再次 save() 不会并发发出第二个请求（不再覆盖 savePromise）
 *   - 保存期间的改动会在当前保存收尾后补存
 *   - 保存中的 flushAndWait() 能正常返回，不会永久挂起
 *   - 保存中触发卸载兜底（keepalive）会立即补发请求
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  syncCanvasState: vi.fn(),
}));

vi.mock("@/features/project/api", () => ({
  projectApi: {
    saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  },
}));

vi.mock("@/features/project/draft-store", () => ({
  saveDraft: (...args: unknown[]) => mocks.saveDraft(...args),
  clearDraft: (...args: unknown[]) => mocks.clearDraft(...args),
}));

vi.mock("@/features/project/store", () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: "p1", syncCanvasState: mocks.syncCanvasState }),
  },
}));

vi.mock("@/features/canvas/stores/canvas-store", () => {
  const snapshot = {
    nodes: [{ id: "n1", data: {} }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    background: "dots" as const,
    theme: "dark" as const,
    minimapVisible: true,
    snapToGrid: false,
  };
  return {
    takeCanvasSnapshot: () => snapshot,
    getLiveViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useCanvasStore: {
      getState: () => ({
        nodes: snapshot.nodes,
        edges: [],
        background: snapshot.background,
        theme: snapshot.theme,
        minimapVisible: true,
        snapToGrid: false,
        agentModel: undefined,
      }),
    },
  };
});

import { saveManager } from "@/features/project/save-manager";

/** 私有方法需要直接驱动，才能精确构造并发时序 */
type Private = {
  save: (keepalive: boolean) => Promise<void>;
};
const priv = saveManager as unknown as Private;

/**
 * SaveManager 是单例，脏状态与定时器会跨用例残留（例如上个用例收尾时排的补存定时器），
 * 会让「离线期间不应发起保存」这类断言误判。每个用例前显式重置。
 */
function resetSaveState() {
  const s = saveManager as unknown as {
    dirty: boolean;
    saving: boolean;
    pendingSave: unknown;
    saveTimer: ReturnType<typeof setTimeout> | null;
    dirtySince: number | null;
    pendingDelay: number;
    offline: boolean;
  };
  if (s.saveTimer) clearTimeout(s.saveTimer);
  s.saveTimer = null;
  s.dirty = false;
  s.saving = false;
  s.pendingSave = null;
  s.dirtySince = null;
  s.pendingDelay = 2000;
  s.offline = false;
}

/** 可控的挂起响应：手动释放后才 resolve */
function gatedResponse() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release: () => release() };
}

describe("SaveManager 并发保存", () => {
  beforeEach(() => {
    mocks.saveProjectRaw.mockReset();
    mocks.saveDraft.mockReset();
    mocks.clearDraft.mockReset();
    mocks.syncCanvasState.mockReset();
    resetSaveState();
  });

  it("保存中再次 save 不并发请求，改动在当前保存收尾后补存", async () => {
    const first = gatedResponse();
    let calls = 0;
    mocks.saveProjectRaw.mockImplementation(() => {
      calls++;
      // 第一次请求挂起，模拟慢网络；后续请求立即成功
      return calls === 1
        ? first.gate.then(() => ({ ok: true, status: 200 }))
        : Promise.resolve({ ok: true, status: 200 });
    });

    saveManager.markDirty();
    const p1 = priv.save(false);
    expect(calls).toBe(1);

    // 保存进行中又产生新改动并再次触发保存
    saveManager.markDirty();
    const p2 = priv.save(false);
    expect(calls).toBe(1); // 关键：不再并发发出第二个请求

    first.release();
    await p1;
    await p2;

    // 收尾后补存，保证最终状态落盘
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it("保存中的 flushAndWait 会等待并最终返回，不会永久挂起", async () => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() => first.gate.then(() => ({ ok: true, status: 200 })));

    saveManager.markDirty();
    const p1 = priv.save(false);

    const waited = saveManager.flushAndWait();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("flushAndWait 未被 resolve")), 1000),
    );

    first.release();
    await p1;
    await Promise.race([waited, timeout]);
    expect(mocks.saveProjectRaw).toHaveBeenCalled();
  });

  it("保存中触发卸载兜底会立即补发 keepalive 请求", async () => {
    const first = gatedResponse();
    let calls = 0;
    mocks.saveProjectRaw.mockImplementation(() => {
      calls++;
      return calls === 1
        ? first.gate.then(() => ({ ok: true, status: 200 }))
        : Promise.resolve({ ok: true, status: 200 });
    });

    saveManager.markDirty();
    const p1 = priv.save(false);
    expect(calls).toBe(1);

    // 页面即将卸载：不能等当前保存，必须立刻把最新快照发出去
    saveManager.markDirty();
    saveManager.flushOnUnload();
    expect(calls).toBe(2);
    expect(mocks.saveProjectRaw.mock.calls[1][2]).toBe(true); // keepalive

    first.release();
    await p1;
  });

  it("多个调用方同时 flushAndWait 都能返回", async () => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() => first.gate.then(() => ({ ok: true, status: 200 })));

    saveManager.markDirty();
    const p1 = priv.save(false);

    const a = saveManager.flushAndWait();
    const b = saveManager.flushAndWait();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("并发 flushAndWait 挂起")), 1000),
    );

    first.release();
    await p1;
    await Promise.race([Promise.all([a, b]), timeout]);
  });

  // 离线 / 恢复在线的用例在 save-manager-offline.test.ts（需要 jsdom 的 window 事件）
});
