/**
 * SaveManager 并发保存回归测试。
 *
 * 覆盖核心不变量：
 *   - 写通道单飞：保存进行中绝不发出第二个服务端写请求（同 baseRevision 并发必然 409）。
 *   - 内容有主：保存 / revision 回写一律按 getCanvasProjectId 寻址。
 *   - 保存期间的改动在收尾后补存（pendingSave）。
 *   - flushAndWait 可正常返回，不永久挂起。
 *   - 保存请求携带 baseRevision + 编辑权租约令牌（fencing token）；无租约不派发。
 *   - 409 = 租约失效（编辑权已属其他页面实例）：同步服务端版本并无条件进入
 *     过期态，停用保存，等待刷新——不存在任何重试路径。
 *   - 服务端是唯一真相源：未落库的改动只保留在内存（dirty），不写本地副本。
 *   - resetForProjectSwitch：切换即丢弃未派发的尾部编辑，派发状态清空。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProjectRaw: vi.fn(),
  updateProjectRevision: vi.fn(),
  markSessionExpired: vi.fn(),
  resetSessionExpired: vi.fn(),
  runProjectWrite: vi.fn(),
  revisions: {} as Record<string, number>,
  canvasProjectId: "p1" as string | null,
  snapshotNodes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/canvas/persistence/project-transport", () => ({
  saveProjectRaw: (...args: unknown[]) => mocks.saveProjectRaw(...args),
  saveProjectDeltaRaw: vi.fn(),
}));

vi.mock("@/features/canvas/session/session-expired-store", () => ({
  useSessionExpiredStore: {
    getState: () => ({
      markExpired: mocks.markSessionExpired,
      resetExpired: mocks.resetSessionExpired,
    }),
  },
}));

vi.mock("@/entities/project", () => ({
  getProjectRevision: (id: string) => mocks.revisions[id] ?? null,
  updateProjectRevision: (id: string, rev: number) => {
    mocks.updateProjectRevision(id, rev);
    mocks.revisions[id] = Math.max(mocks.revisions[id] ?? 1, rev);
  },
  runProjectWrite: <T,>(fn: () => Promise<T>) => mocks.runProjectWrite(fn) as Promise<T>,
}));

vi.mock("@/lib/api/error-message", () => ({
  parseErrorBody: (body: unknown) =>
    body && typeof body === "object" ? (body as Record<string, unknown>) : null,
}));

vi.mock("@/features/canvas/stores/canvas-document-store", () => {
  return {
    takeCanvasSnapshot: () => ({
      // structuredClone 语义由真实现保证，mock 直接返回注入的节点即可
      nodes: structuredClone(mocks.snapshotNodes.length > 0 ? mocks.snapshotNodes : [{ id: "n1", data: {} }]),
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      minimapVisible: true,
      snapEnabled: false,
    }),
    getCanvasProjectId: () => mocks.canvasProjectId,
    getCanvasAgentModel: () => undefined,
  };
});

// 租约模块零依赖，用真实实现锁定 keyed 读取语义
import { clearCanvasLease, setCanvasLease } from "@/features/canvas/persistence/canvas-lease";
import { saveManager } from "@/features/canvas/persistence/save-manager";

/** 私有方法需要直接驱动，才能精确构造并发时序 */
type Private = {
  save: (keepalive: boolean, skipUnauthorized?: boolean) => Promise<void>;
};
const priv = saveManager as unknown as Private;

function resetSaveState() {
  saveManager.resetForProjectSwitch();
  const s = saveManager as unknown as {
    dirty: boolean;
    saving: boolean;
    expired: boolean;
    offline: boolean;
    pendingSave: unknown;
    saveTimer: ReturnType<typeof setTimeout> | null;
    dirtySince: number | null;
    pendingDelay: number;
    savingProjectId: string | null;
  };
  s.dirty = false;
  s.saving = false;
  s.pendingSave = null;
  s.dirtySince = null;
  s.pendingDelay = 2000;
  s.offline = false;
  s.savingProjectId = null;
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
    mocks.snapshotNodes = [{ id: "n1", data: {} }];
    // 默认写锁直通；队列时序用例按需改写成可控挂起
    mocks.runProjectWrite.mockImplementation((fn: () => Promise<unknown>) => fn());
    resetSaveState();
    // 默认已通过握手取得编辑权；专项用例自行改写租约状态
    setCanvasLease("p1", 42);
  });

  it("保存请求携带 baseRevision 与编辑权租约令牌（fencing token）", async () => {
    mocks.revisions["p1"] = 7;
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });

    saveManager.markDirty();
    await priv.save(false);

    const body = JSON.parse(mocks.saveProjectRaw.mock.calls[0][1] as string);
    expect(body.baseRevision).toBe(7);
    expect(body.lease).toBe(42);
    // 成功后本地版本推进到服务端版本 + 1
    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 8);
  });

  it("无租约不派发保存（编辑权未取得 / 租约属于其他项目），保持 dirty", async () => {
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });

    // 握手未完成：没有任何租约
    clearCanvasLease("p1");
    saveManager.markDirty();
    await priv.save(false);
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect((saveManager as unknown as { dirty: boolean }).dirty).toBe(true);

    // 租约 keyed 寻址：令牌属于 p2 时 p1 同样不可写
    setCanvasLease("p2", 9);
    saveManager.markDirty();
    await priv.save(false);
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect((saveManager as unknown as { dirty: boolean }).dirty).toBe(true);
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

  it("在途保存按单次 5s、整体 15s 放行，而不是一次等满 15s", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() => first.gate.then(() => ({ ok: true, status: 200 })));

    try {
      saveManager.markDirty();
      const p1 = priv.save(false);

      let settled = false;
      saveManager.flushAndWait().then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(5_000);
      // 定时器回调后的 resolve 需要若干微任务回合才落到 then
      for (let i = 0; i < 10 && !settled; i += 1) await Promise.resolve();
      expect(settled).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith("[SaveManager] flushAndWait timed out after", 5_000, "ms");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 10 && !settled; i += 1) await Promise.resolve();
      expect(settled).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(3);

      first.release();
      await p1;
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
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

  it("写通道单飞：卸载兜底在保存中不双发请求，增量保持 dirty", async () => {
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

    // 页面即将卸载：绝不发第二个 PUT（同 baseRevision 并发必然 409）
    saveManager.markDirty();
    saveManager.flushOnUnload();
    expect(calls).toBe(1);

    first.release();
    await p1;

    // 增量未被丢弃：仍保持 dirty，页面存活时由后续保存承接
    const s = saveManager as unknown as { dirty: boolean };
    expect(s.dirty).toBe(true);
  });

  it("保存按内容所有者寻址：job / revision 回写均用 canvasProjectId", async () => {
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    expect(mocks.saveProjectRaw.mock.calls[0][0]).toBe("p1");
    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 2);
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

  it("409（租约失效）：同步版本并无条件过期，仅发一次请求不重试", async () => {
    mocks.saveProjectRaw.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "canvas_revision_conflict", ctx: { revision: 5 } }),
    });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    // 无重试路径：同步版本 + 过期，一次请求即收敛
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1);
    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 5);
    expect(mocks.markSessionExpired).toHaveBeenCalled();

    const s = saveManager as unknown as { expired: boolean };
    expect(s.expired).toBe(true);

    // 过期后的编辑一律不发保存请求：本地改动无处可写，唯一出口是刷新重取编辑权
    mocks.saveProjectRaw.mockClear();
    saveManager.markDirty();
    await new Promise((r) => setTimeout(r, 650));
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
  });

  it("resetForProjectSwitch：切换即丢弃未派发的尾部编辑，派发状态清空", async () => {
    saveManager.markDirty();
    const s = saveManager as unknown as { dirty: boolean };
    expect(s.dirty).toBe(true);

    saveManager.resetForProjectSwitch();

    const st = saveManager as unknown as { dirty: boolean; saveTimer: unknown };
    expect(st.dirty).toBe(false);
    expect(st.saveTimer).toBeNull();
    expect(saveManager.getSavePhase()).toBe("unknown");

    // 状态已清空：后续不会再派发旧内容的保存
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
    await new Promise((r) => setTimeout(r, 650));
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
  });

  it.each([
    ["成功", { ok: true, status: 200 }],
    ["409", { ok: false, status: 409, json: async () => ({ error: "canvas_revision_conflict" }) }],
    ["401", { ok: false, status: 401 }],
    ["500", { ok: false, status: 500 }],
  ])("resetForProjectSwitch：同项目重进后，上一会话的迟到 %s 响应不影响新画布", async (_label, response) => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementationOnce(() => first.gate.then(() => response));

    saveManager.markDirty();
    const p = priv.save(false);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));

    // A → B → A：旧 A 请求仍在途，新 A 会话完成握手并建立基线。
    // 新基线内容与旧派发快照不同，用于锁住“迟到成功不得覆盖基线”。
    mocks.canvasProjectId = "p2";
    saveManager.resetForProjectSwitch();
    mocks.canvasProjectId = "p1";
    saveManager.resetForProjectSwitch();
    mocks.snapshotNodes = [{ id: "n-new", data: {} }];
    saveManager.setBaselineFromCurrent("p1");

    // 派发所有者属于上一个 A 会话；新 A 基线已建立，不得显示 saving
    expect(saveManager.getSavePhase()).toBe("saved");

    first.release();
    await p;

    // 迟到响应属于上一会话：无论成功、409、401 还是 5xx，都不得改变新会话状态
    const st = saveManager as unknown as {
      dirty: boolean;
      expired: boolean;
      authBlocked: boolean;
      persistedCanvas: { data: { nodes: Array<{ id: string }> } } | null;
    };
    expect(st.dirty).toBe(false);
    expect(st.expired).toBe(false);
    expect(st.authBlocked).toBe(false);
    // 成功变体的唯一代际副作用是基线回写：必须仍是新会话基线，而非旧派发快照
    expect(st.persistedCanvas?.data.nodes[0]?.id).toBe("n-new");
    expect(mocks.markSessionExpired).not.toHaveBeenCalled();
    expect(saveManager.getSavePhase()).toBe("saved");
  });

  it("排队中的旧会话保存不会在重进后携带新租约发出", async () => {
    let release!: () => void;
    mocks.runProjectWrite.mockImplementationOnce((fn: () => Promise<unknown>) => {
      // 写锁回调由用例手动放行：此前请求尚未发出
      return new Promise<void>((resolve, reject) => {
        release = () => {
          fn().then(() => resolve(), reject);
        };
      });
    });

    saveManager.markDirty();
    const p = priv.save(false);
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();

    // A → B → A：旧保存仍在写锁队列中，新会话取得新租约并建立基线
    mocks.canvasProjectId = "p2";
    saveManager.resetForProjectSwitch();
    mocks.canvasProjectId = "p1";
    saveManager.resetForProjectSwitch();
    setCanvasLease("p1", 99);
    saveManager.setBaselineFromCurrent("p1");

    release();
    await p;

    // 旧快照不得携带新会话的租约 / revision 发出，否则会覆盖刚采纳的服务端内容
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();
    expect(saveManager.getSavePhase()).toBe("saved");
  });

  it("旧项目迟到 evict 不把新画布置为过期", () => {
    mocks.canvasProjectId = "p2";

    saveManager.notifyEvicted("p1");

    const st = saveManager as unknown as { expired: boolean };
    expect(st.expired).toBe(false);
    expect(saveManager.getSavePhase()).toBe("unknown");
  });

  it("resetForProjectSwitch：同项目恢复（clearExpired:false）不冲掉 evict 置的过期态", async () => {
    // 场景：画布加载在途时收到 evict（编辑权被其他页面实例取得），
    // 随后服务端数据恢复完成——过期态必须保留，弹窗不能闪现即消
    saveManager.notifyEvicted("p1");
    expect((saveManager as unknown as { expired: boolean }).expired).toBe(true);

    saveManager.resetForProjectSwitch({ clearExpired: false });

    expect((saveManager as unknown as { expired: boolean }).expired).toBe(true);
    // 过期依旧拦截一切保存派发
    mocks.saveProjectRaw.mockClear();
    saveManager.markDirty();
    await new Promise((r) => setTimeout(r, 650));
    expect(mocks.saveProjectRaw).not.toHaveBeenCalled();

    // 真正的项目切换（默认行为）才解除过期
    saveManager.resetForProjectSwitch();
    expect((saveManager as unknown as { expired: boolean }).expired).toBe(false);
  });

  it("5xx 失败：dirty 恢复继续重试，不写本地副本", async () => {
    mocks.saveProjectRaw.mockResolvedValue({ ok: false, status: 500 });

    saveManager.markDirty();
    const p = priv.save(false);
    await p;

    const s = saveManager as unknown as { dirty: boolean };
    expect(s.dirty).toBe(true);
    expect(saveManager.getSavePhase()).toBe("unsaved");
  });

  it("在途保存失败且已切换项目：失败不记到新项目头上", async () => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() =>
      first.gate.then(() => ({ ok: false, status: 500 })),
    );

    saveManager.markDirty();
    const p = priv.save(false);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));

    // 保存请求在途时切换到新项目 p2
    mocks.canvasProjectId = "p2";
    saveManager.resetForProjectSwitch();
    expect(saveManager.getSavePhase()).toBe("unknown");

    first.release();
    await p;

    // 失败 job 属于 p1：不把 dirty 标到 p2，避免无意义重存 p2 的原始内容
    const st = saveManager as unknown as { dirty: boolean; saveTimer: unknown };
    expect(st.dirty).toBe(false);
    expect(st.saveTimer).toBeNull();
    expect(saveManager.getSavePhase()).toBe("unknown");
  });

  it("过期态随画布切换重置：保存通道恢复可用，UI 弹窗状态解除", async () => {
    // 409 无 revision 载荷：同步不了版本，但过期语义不变（不重试）
    mocks.saveProjectRaw.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "canvas_revision_conflict" }),
    });
    saveManager.markDirty();
    await priv.save(false);
    const s = saveManager as unknown as { expired: boolean };
    expect(s.expired).toBe(true);
    expect(saveManager.getSavePhase()).toBe("expired");

    saveManager.resetForProjectSwitch();
    expect(s.expired).toBe(false);
    expect(mocks.resetSessionExpired).toHaveBeenCalled();
    expect(saveManager.getSavePhase()).toBe("unknown");

    // 过期解除后保存通道恢复
    mocks.saveProjectRaw.mockResolvedValue({ ok: true, status: 200 });
    saveManager.markDirty();
    await priv.save(false);
    expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(2);
    expect(saveManager.getSavePhase()).toBe("saved");
  });

  it("401 迟到（响应前已切换项目）：会话阻塞归属旧项目，不毒化新画布", async () => {
    const first = gatedResponse();
    mocks.saveProjectRaw.mockImplementation(() =>
      first.gate.then(() => ({ ok: false, status: 401 })),
    );

    saveManager.markDirty();
    const p = priv.save(false);
    await vi.waitFor(() => expect(mocks.saveProjectRaw).toHaveBeenCalledTimes(1));

    mocks.canvasProjectId = "p2";
    saveManager.resetForProjectSwitch();

    first.release();
    await p;

    // 401 属于旧项目的在途请求，不得把新画布置为 blocked
    expect(saveManager.getSavePhase()).toBe("unknown");
    expect((saveManager as unknown as { authBlocked: boolean }).authBlocked).toBe(false);
  });

  it("旧项目 401 迟到不吞掉新项目的补存诉求", async () => {
    const first = gatedResponse();
    let calls = 0;
    mocks.saveProjectRaw.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? first.gate.then(() => ({ ok: false, status: 401 }))
        : Promise.resolve({ ok: true, status: 200 });
    });

    saveManager.markDirty();
    const p = priv.save(false);
    await vi.waitFor(() => expect(calls).toBe(1));

    mocks.canvasProjectId = "p2";
    setCanvasLease("p2", 43);
    saveManager.resetForProjectSwitch();
    saveManager.markDirty();
    saveManager.flushOnHide();
    // 旧项目的写请求仍在途，补存诉求排在新项目名下
    expect(saveManager.getSavePhase()).toBe("unsaved");

    first.release();
    await p;

    expect(saveManager.getSavePhase()).toBe("unsaved");
    await vi.waitFor(() => expect(calls).toBe(2));
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

    // 冲突属于旧项目：同步其版本即可，过期态不落到新画布上
    expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 5);
    expect(mocks.markSessionExpired).not.toHaveBeenCalled();
    expect(saveManager.getSavePhase()).toBe("unknown");
    const st = saveManager as unknown as { expired: boolean; dirty: boolean };
    expect(st.expired).toBe(false);
    expect(st.dirty).toBe(false);
  });

  // 离线 / 恢复在线的用例在 save-manager-offline.test.ts（需要 jsdom 的 window 事件）
});
