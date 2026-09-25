/**
 * SaveManager 并发保存回归测试。
 *
 * 覆盖核心不变量：
 *   - 写通道单飞：保存进行中绝不发出第二个服务端写请求；
 *     卸载兜底改为写本地草稿承接增量（旧实现并发第二个 PUT 必然 409）。
 *   - 内容有主：保存 / 草稿 / revision 回写一律按 getCanvasProjectId 寻址。
 *   - 保存期间的改动在收尾后补存（pendingSave / flushSave）。
 *   - flushAndWait 可正常返回，不永久挂起。
 *   - 409 = 其他标签页冲突：进入过期态，停用保存、草稿承接，代际按服务端版本推算。
 *   - resetForProjectSwitch：切换前未派发的尾部编辑固化草稿，派发状态清空。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  saveDraft: vi.fn(),
  clearStaleDraft: vi.fn(),
  syncCanvasState: vi.fn(),
  updateProjectRevision: vi.fn(),
  markSessionExpired: vi.fn(),
  resetSessionExpired: vi.fn(),
  revisions: {} as Record<string, number>,
  canvasProjectId: "p1" as string | null,
}));

vi.mock("@/features/project/api", () => ({
  projectApi: {
    saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  },
}));

vi.mock("@/features/project/draft-store", () => ({
  saveDraft: (...args: unknown[]) => mocks.saveDraft(...args),
  clearStaleDraft: (...args: unknown[]) => mocks.clearStaleDraft(...args),
}));

vi.mock("@/features/project/session-expired-store", () => ({
  useSessionExpiredStore: {
    getState: () => ({
      markExpired: mocks.markSessionExpired,
      resetExpired: mocks.resetSessionExpired,
    }),
  },
}));

vi.mock("@/features/project/store", () => ({
  useProjectStore: {
    getState: () => ({
      projects: Object.entries(mocks.revisions).map(([id, revision]) => ({ id, revision })),
      syncCanvasState: mocks.syncCanvasState,
      updateProjectRevision: (id: string, rev: number) => {
        mocks.updateProjectRevision(id, rev);
        mocks.revisions[id] = Math.max(mocks.revisions[id] ?? 1, rev);
      },
    }),
  },
}));

vi.mock("@/lib/api/error-message", () => ({
  parseErrorBody: (body: unknown) =>
    body && typeof body === "object" ? (body as Record<string, unknown>) : null,
}));

vi.mock("@/features/canvas/stores/canvas-store", () => {
  const snapshot = {
    nodes: [{ id: "n1", data: {} }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    background: "dots" as const,
    minimapVisible: true,
    snapToGrid: false,
  };
  return {
    takeCanvasSnapshot: () => snapshot,
    getCanvasProjectId: () => mocks.canvasProjectId,
    useCanvasStore: {
      getState: () => ({
        nodes: snapshot.nodes,
        edges: [],
        background: snapshot.background,
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
  save: (keepalive: boolean, skipUnauthorized?: boolean) => Promise<void>;
};
const priv = saveManager as unknown as Private;

function resetSaveState() {
  const s = saveManager as unknown as {
    dirty: boolean;
    saving: boolean;
    expired: boolean;
    expiredDirty: boolean;
    offline: boolean;
    pendingSave: unknown;
    saveTimer: ReturnType<typeof setTimeout> | null;
    draftTimer: ReturnType<typeof setTimeout> | null;
    dirtySince: number | null;
    pendingDelay: number;
  };
  if (s.saveTimer) clearTimeout(s.saveTimer);
  if (s.draftTimer) clearTimeout(s.draftTimer);
  s.saveTimer = null;
  s.draftTimer = null;
  s.dirty = false;
  s.saving = false;
  s.expired = false;
  s.expiredDirty = false;
  s.pendingSave = null;
  s.dirtySince = null;
  s.pendingDelay = 2000;
  s.offline = false;
  for (const k of Object.keys(mocks.revisions)) delete mocks.revisions[k];
}

/** 可控的挂起响应：手动释放后才 resolve */
function gatedResponse() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release: () => release() };
}

describe("SaveManager 并发保存", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canvasProjectId = "p1";
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
    // saveMutex 把网络回调排到微任务：等请求真正发出
    await vi.waitFor(() => expect(calls).toBe(1));

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

  it("写通道单飞：卸载兜底在保存中不双发请求，增量固化进草稿", async () => {
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
    await vi.waitFor(() => expect(calls).toBe(1));

    // 页面即将卸载：绝不发第二个 PUT（同 baseRevision 并发必然 409），增量由草稿承接
    saveManager.markDirty();
    saveManager.flushOnUnload();
    expect(calls).toBe(1);
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    // rev = 服务端 revision(1) + 在途保存(1) + 1 —— 若落库将产生的代际
    expect(mocks.saveDraft.mock.calls[0][0]).toBe("p1");
    expect(mocks.saveDraft.mock.calls[0][1]).toBe(3);

    first.release();
    await p1;
  });

  it("保存中的 flushSave 记录补存诉求，收尾后立即补存", async () => {
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
    await vi.waitFor(() => expect(calls).toBe(1));

    saveManager.markDirty();
    saveManager.flushSave(); // 页面仍存活：不能双发，但收尾后要立即补存
    expect(calls).toBe(1);

    first.release();
    await p1;
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it("保存按内容所有者寻址：job / 草稿 / revision 回写均用 canvasProjectId", async () => {
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    expect(mocks.saveProjectRaw.mock.calls[0][0]).toBe("p1");
    expect(mocks.syncCanvasState.mock.calls[0][0]).toBe("p1");
    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 2);
    // 落库成功后清理陈旧代际草稿（serverRev = baseRevision + 1）
    expect(mocks.clearStaleDraft).toHaveBeenCalledWith("p1", 2);
  });

  it("内容无主（画布未加载）时不派发保存", async () => {
    mocks.canvasProjectId = null;
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    // dirty 保持：加载完成后由后续流程承接
    const s = saveManager as unknown as { dirty: boolean };
    expect(s.dirty).toBe(true);
  });

  it("409 冲突：进入过期态，停用保存，草稿按服务端版本承接", async () => {
    mocks.saveProjectRaw.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "canvas_revision_conflict", ctx: { revision: 5 } }),
    });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 5);
    expect(mocks.markSessionExpired).toHaveBeenCalled();
    // 409 回调先同步服务端版本(5)，排队在其后的草稿写入 rev = 5 + 1 = 6
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraft.mock.calls[0][1]).toBe(6);

    const s = saveManager as unknown as { expired: boolean };
    expect(s.expired).toBe(true);

    // 过期后的编辑不再发保存请求，仅持续写草稿
    mocks.saveProjectRaw.mockClear();
    saveManager.markDirty();
    await new Promise((r) => setTimeout(r, 650)); // 等防抖草稿定时器（500ms）触发
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect(mocks.saveDraft).toHaveBeenCalledTimes(2);
  });

  it("resetForProjectSwitch：切换前未派发的尾部编辑固化草稿，派发状态清空", async () => {
    saveManager.markDirty();
    const s = saveManager as unknown as { dirty: boolean };
    expect(s.dirty).toBe(true);

    saveManager.resetForProjectSwitch();

    // 草稿按旧 owner 固化：rev = 服务端 revision(1) + 未在途(0) + 1
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraft.mock.calls[0][0]).toBe("p1");
    expect(mocks.saveDraft.mock.calls[0][1]).toBe(2);
    const st = saveManager as unknown as { dirty: boolean; saveTimer: unknown; draftTimer: unknown };
    expect(st.dirty).toBe(false);
    expect(st.saveTimer).toBeNull();
    expect(st.draftTimer).toBeNull();

    // 状态已清空：后续不会再派发旧内容的保存
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
    await vi.waitFor(async () => {
      await new Promise((r) => setTimeout(r, 650)); // 确认防抖草稿定时器已被清掉
    });
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("5xx 失败：dirty 恢复并按失败 job 固化草稿", async () => {
    mocks.saveProjectRaw.mockResolvedValue({ ok: false, status: 500 });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraft.mock.calls[0][1]).toBe(2); // baseRevision(1) + 1
    const s = saveManager as unknown as { dirty: boolean };
    expect(s.dirty).toBe(true);
  });

  it("在途保存失败且已切换项目：失败 job 固化为旧项目草稿，不污染新项目", async () => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() =>
      first.gate.then(() => ({ ok: false, status: 500 })),
    );

    saveManager.markDirty();
    const p = priv.save(false);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));

    // 保存请求在途时切换到新项目 p2（dirty 已被派发消费，切换本身不固化草稿）
    mocks.canvasProjectId = "p2";
    saveManager.resetForProjectSwitch();

    first.release();
    await p;

    // 失败 job 属于 p1：按其本应产生的代际（1+1）固化 p1 草稿
    expect(mocks.saveDraft).toHaveBeenCalledWith("p1", 2, expect.anything());
    expect(mocks.saveDraft).not.toHaveBeenCalledWith("p2", expect.anything(), expect.anything());
    // 失败不标到新项目头上：不再派发 p2 的无意义重存
    const st = saveManager as unknown as { dirty: boolean; saveTimer: unknown };
    expect(st.dirty).toBe(false);
    expect(st.saveTimer).toBeNull();
  });

  it("过期态随画布切换重置：保存通道恢复可用，UI 弹窗状态解除", async () => {
    mocks.saveProjectRaw.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "canvas_revision_conflict", ctx: { revision: 5 } }),
    });
    saveManager.markDirty();
    await priv.save(false);
    const s = saveManager as unknown as { expired: boolean };
    expect(s.expired).toBe(true);

    saveManager.resetForProjectSwitch();
    expect(s.expired).toBe(false);
    expect(mocks.resetSessionExpired).toHaveBeenCalled();

    // 过期解除后保存通道恢复
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
    saveManager.markDirty();
    await priv.save(false);
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
  });

  it("409 迟到（响应前已切换项目）：冲突归属旧项目，不毒化新画布", async () => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() =>
      first.gate.then(() => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "canvas_revision_conflict", ctx: { revision: 5 } }),
      })),
    );

    saveManager.markDirty();
    const p = priv.save(false);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));

    // 409 响应尚未到达时已切换到新项目 p2
    mocks.canvasProjectId = "p2";
    saveManager.resetForProjectSwitch();

    first.release();
    await p;

    // 冲突属于旧项目：按服务端当前版本(5)固化其草稿，过期态不落地
    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 5);
    expect(mocks.saveDraft).toHaveBeenCalledWith("p1", 6, expect.anything());
    expect(mocks.markSessionExpired).not.toHaveBeenCalled();
    const st = saveManager as unknown as { expired: boolean; dirty: boolean };
    expect(st.expired).toBe(false);
    expect(st.dirty).toBe(false);
  });

  // 离线 / 恢复在线的用例在 save-manager-offline.test.ts（需要 jsdom 的 window 事件）
});
