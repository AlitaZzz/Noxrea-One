// @vitest-environment jsdom
/**
 * useFileAccessUrl（specs/storage-signed-direct-delivery.md 规则 3）：
 * 异步解析、外部值直通、失败态与 refresh 重新描述、账号切换重置。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message = "api error") {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { api: vi.fn(), ApiError };
});
vi.mock("@/lib/api/client", () => ({ api: mocks.api, ApiError: mocks.ApiError }));

import { peekMediaAccess, type ResolvedMediaUrl } from "@/lib/file-access";
import { resetProactiveRefresh } from "@/lib/file-access/proactive";
import { captureSession, changeSession } from "@/lib/session-lifecycle";
import { useFileAccessUrl } from "@/lib/use-file-access-url";

const KEY = makeStorageKey("hook-signed", ".png");

/** 测试侧收窄：生产侧只暴露带寿命字段的 `peekMediaAccess` */
function peekMediaUrl(value: string | null | undefined): ResolvedMediaUrl | null {
  const access = peekMediaAccess(value);
  return access ? { url: access.url, delivery: access.delivery } : null;
}

/** 描述接口的整批响应（规则 2.3）：单条目 + 同序同长 */
function signedBatch(
  url: string,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
  refreshAt = expiresAt - 600,
) {
  return {
    items: [{ url, delivery: "signed" as const, expiresAt, refreshAt }],
  };
}

/** 多条目整批响应：条目顺序与请求顺序一致 */
function signedBatches(entries: Array<{ url: string; expiresAt: number; refreshAt: number }>) {
  return {
    items: entries.map((entry) => ({ ...entry, delivery: "signed" as const })),
  };
}

/** stream 形态的整批响应（local 后端） */
function streamBatch(key: string) {
  return { items: [{ url: `/api/files/${key}`, delivery: "stream" as const }] };
}

/** 若干微任务：批量派发（同拍合并 → 微任务批次）在它们之内完成 */
async function settleMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * 挂起的批量请求，随会话中止而失败：真实 `api()` 会把会话 signal 并进 fetch，
 * 会话切换即中止在途请求；替身必须同形，否则批席位会被永久占住（并发上限 2）。
 */
function hangUntilSessionChange(): void {
  const session = captureSession();
  mocks.api.mockImplementation(() => new Promise((_resolve, reject) => {
    session.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
}

beforeEach(() => {
  mocks.api.mockReset();
  // 会话切换即清空缓存/在途/排队（解析服务的唯一重置入口）
  changeSession();
});

afterEach(() => {
  // 先按 fake timer 清理共享定时器/监听，再恢复真实时钟与 Math.random
  resetProactiveRefresh();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useFileAccessUrl", () => {
  it("外部 URL 同步直通，不请求描述接口", () => {
    const { result } = renderHook(() => useFileAccessUrl("https://cdn.example.com/a.png"));
    expect(result.current.url).toBe("https://cdn.example.com/a.png");
    expect(result.current.failed).toBe(false);
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("空值返回 undefined 且不发请求", () => {
    const { result } = renderHook(() => useFileAccessUrl(undefined));
    expect(result.current.url).toBeUndefined();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("存储 key 解析为最终地址（解析前为 undefined）", async () => {
    let resolveApi!: (value: unknown) => void;
    mocks.api.mockImplementation(() => new Promise((resolve) => { resolveApi = resolve; }));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    expect(result.current.url).toBeUndefined();
    // 批量派发在微任务里（同拍合并），先让批次真正发出再结算
    await act(async () => { await settleMicrotasks(); });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    await act(async () => { resolveApi(signedBatch("https://signed/key")); });
    await waitFor(() => expect(result.current.url).toBe("https://signed/key"));
    expect(result.current.delivery).toBe("signed");
  });

  it("描述失败进入 failed 态，refresh 重新描述并恢复", async () => {
    mocks.api.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeUndefined();

    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/recovered"));
    // refresh 的 promise 由 effect 结算：先在 act 内发起并让 effect 跑完，再等待结果
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.refresh(); });
    await expect(pending).resolves.toBe("https://signed/recovered");
    await waitFor(() => expect(result.current.url).toBe("https://signed/recovered"));
    expect(result.current.failed).toBe(false);
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("retrySigned：每个失败地址各获得一次重描述，换到新地址后再次失败可再重试（规则 3.6）", async () => {
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/expired"));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.url).toBe("https://signed/expired"));
    expect(result.current.delivery).toBe("signed");

    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/fresh"));
    // retrySigned 要等 effect 发起重新描述后才结算：在 act 内启动、在 act 外等待，
    // 不能在同一 act 回调里 await（effect 尚未运行，promise 永远不结算）
    let firstRetry!: Promise<string | null>;
    act(() => { firstRetry = result.current.retrySigned(); });
    // waitFor 的轮询在 act 内结算 effect 的 state 更新；pending 此时已结算，
    // 再在 act 内等它拿到 retrySigned 的返回地址与 reloadToken 更新
    await waitFor(() => expect(result.current.url).toBe("https://signed/fresh"));
    await act(async () => { await expect(firstRetry).resolves.toBe("https://signed/fresh"); });
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(result.current.reloadToken).toBe(1);

    // 新地址再次失败（下一次过期）：失败地址已变化，重试预算重新武装。
    // 旧的「按逻辑源」闩锁会在这里直接返回 null，本断言即回归点。
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/fresh-2"));
    let secondRetry!: Promise<string | null>;
    act(() => { secondRetry = result.current.retrySigned(); });
    await waitFor(() => expect(result.current.url).toBe("https://signed/fresh-2"));
    await act(async () => { await expect(secondRetry).resolves.toBe("https://signed/fresh-2"); });
    expect(mocks.api).toHaveBeenCalledTimes(3);
    expect(result.current.reloadToken).toBe(2);
  });

  it("retrySigned：重描述仍返回同一地址时只刷新一次，不无限重试", async () => {
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/same"));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.url).toBe("https://signed/same"));

    // 同一签名窗口内 forceRefresh 仍签出同一地址：重挂一次元素即可，随后闩锁命中
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/same"));
    let retried!: Promise<string | null>;
    act(() => { retried = result.current.retrySigned(); });
    await waitFor(() => expect(result.current.reloadToken).toBe(1));
    await act(async () => { await expect(retried).resolves.toBe("https://signed/same"); });
    expect(mocks.api).toHaveBeenCalledTimes(2);

    expect(await result.current.retrySigned()).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(result.current.reloadToken).toBe(1);
  });

  it("retrySigned：重描述失败也消耗该地址的重试预算（规则 3.6）", async () => {
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old"));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.url).toBe("https://signed/old"));

    // 对象已删：重新描述返回 404，失败态由 effect 提供
    mocks.api.mockRejectedValueOnce(new mocks.ApiError(404));
    let retried!: Promise<string | null>;
    act(() => { retried = result.current.retrySigned(); });
    await waitFor(() => expect(result.current.failed).toBe(true));
    await act(async () => { await expect(retried).resolves.toBeNull(); });
    expect(mocks.api).toHaveBeenCalledTimes(2);

    // 同一地址只重描述一次：失败也不能把预算重置
    expect(await result.current.retrySigned()).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("retrySigned：stream / 外部地址返回 null，不重新描述", async () => {
    mocks.api.mockResolvedValueOnce(streamBatch(KEY));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.url).toBe(`/api/files/${KEY}`));

    expect(await result.current.retrySigned()).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(1);

    const external = renderHook(() => useFileAccessUrl("https://cdn.example.com/a.png"));
    expect(await external.result.current.retrySigned()).toBeNull();
  });

  describe("主动刷新（规则 3.8）", () => {
    const NOW = Date.parse("2026-01-01T00:00:00Z");
    const NOW_SECONDS = Math.floor(NOW / 1000);
    const EXPIRES = NOW_SECONDS + 3600;
    const REFRESH = NOW_SECONDS + 2880;
    const REFRESH_DELAY_MS = 2_880_000;
    const NEXT_EXPIRES = EXPIRES + 3600;
    const NEXT_REFRESH = REFRESH + 3600;

    /** 固定系统时间；random=0.5 → 会话抖动系数 0，计划时刻就是 refreshAt */
    function fakeClock(): void {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      vi.spyOn(Math, "random").mockReturnValue(0.5);
    }

    async function settle(): Promise<void> {
      await settleMicrotasks(10);
    }

    it("refreshAt 到点后台重描述：不替换当前地址，缓存换成新地址", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      const { result } = renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });
      expect(result.current.url).toBe("https://signed/old");
      expect(mocks.api).toHaveBeenCalledTimes(1);

      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/new", NEXT_EXPIRES, NEXT_REFRESH));
      await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS - 1); });
      expect(mocks.api).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);
      // 不打断已挂载元素：展示地址保持旧值，缓存已换成新地址
      expect(result.current.url).toBe("https://signed/old");
      expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/new", delivery: "signed" });
    });

    it("元素失败时优先使用后台刷新的新鲜地址，不再发描述请求", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      const { result } = renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/new", NEXT_EXPIRES, NEXT_REFRESH));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);

      let retried!: Promise<string | null>;
      act(() => { retried = result.current.retrySigned(); });
      await act(async () => { await expect(retried).resolves.toBe("https://signed/new"); });
      expect(mocks.api).toHaveBeenCalledTimes(2);
      expect(result.current.reloadToken).toBe(1);
      expect(result.current.url).toBe("https://signed/new");
    });

    it("旧地址重试预算用尽后，后台刷新的新地址仍然生效", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      const { result } = renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      // 元素失败，重描述仍返回同一地址：旧地址的重试预算用尽
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      let firstRetry!: Promise<string | null>;
      act(() => { firstRetry = result.current.retrySigned(); });
      await act(async () => { await settle(); });
      await act(async () => { await expect(firstRetry).resolves.toBe("https://signed/old"); });
      expect(result.current.reloadToken).toBe(1);

      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/new", NEXT_EXPIRES, NEXT_REFRESH));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(3);

      // 新地址判断先于「同一失败地址只重试一次」的闩锁
      let secondRetry!: Promise<string | null>;
      act(() => { secondRetry = result.current.retrySigned(); });
      await act(async () => { await expect(secondRetry).resolves.toBe("https://signed/new"); });
      expect(mocks.api).toHaveBeenCalledTimes(3);
      expect(result.current.reloadToken).toBe(2);
      expect(result.current.url).toBe("https://signed/new");
    });

    it("后台刷新失败不进入失败态，按退避重试", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      const { result } = renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      // 网络层失败（status 0）属于瞬时故障
      mocks.api.mockRejectedValueOnce(new mocks.ApiError(0));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);
      expect(result.current.url).toBe("https://signed/old");
      expect(result.current.failed).toBe(false);

      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/new", NEXT_EXPIRES, NEXT_REFRESH));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(3);
      expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/new", delivery: "signed" });
      expect(result.current.failed).toBe(false);
    });

    it("后台刷新遇终态失败不再退避重试（404）", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      mocks.api.mockRejectedValueOnce(new mocks.ApiError(404));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);

      // 对象已删：重试只会把同一请求再打一遍，等到期交给元素失败路径
      await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
      expect(mocks.api).toHaveBeenCalledTimes(2);
    });

    it("定时器被节流时，焦点唤醒补做到期刷新", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/new", NEXT_EXPIRES, NEXT_REFRESH));
      // 系统时间越过到期点但不推进定时器：模拟后台标签页的定时器节流
      vi.setSystemTime(NOW + REFRESH_DELAY_MS + 120_000);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);
      expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/new", delivery: "signed" });
    });

    it("卸载后不再后台重描述", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      const { unmount } = renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });
      unmount();

      await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS); });
      expect(mocks.api).toHaveBeenCalledTimes(1);
    });

    it("同一到期时刻的多个 Hook 合并为一次后台描述", async () => {
      fakeClock();
      const keyB = makeStorageKey("hook-signed-b", ".png");
      mocks.api.mockResolvedValueOnce(signedBatches([
        { url: "https://signed/a", expiresAt: EXPIRES, refreshAt: REFRESH },
        { url: "https://signed/b", expiresAt: EXPIRES, refreshAt: REFRESH },
      ]));
      const first = renderHook(() => useFileAccessUrl(KEY));
      const second = renderHook(() => useFileAccessUrl(keyB));
      await act(async () => { await settle(); });
      expect(mocks.api).toHaveBeenCalledTimes(1);
      expect(first.result.current.url).toBe("https://signed/a");
      expect(second.result.current.url).toBe("https://signed/b");

      mocks.api.mockResolvedValueOnce(signedBatches([
        { url: "https://signed/a2", expiresAt: NEXT_EXPIRES, refreshAt: NEXT_REFRESH },
        { url: "https://signed/b2", expiresAt: NEXT_EXPIRES, refreshAt: NEXT_REFRESH },
      ]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);
      expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/a2", delivery: "signed" });
      expect(peekMediaUrl(keyB)).toEqual({ url: "https://signed/b2", delivery: "signed" });
    });

    it("新描述建议时刻仍在过去时停止循环（客户端时钟超前）", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      // expiresAt 推进了，但 refreshAt 仍落在客户端过去：立即再刷会自旋
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/new", NEXT_EXPIRES, NOW_SECONDS));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
      expect(mocks.api).toHaveBeenCalledTimes(2);
    });

    it("后台描述未推进寿命时停止循环", async () => {
      fakeClock();
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      renderHook(() => useFileAccessUrl(KEY));
      await act(async () => { await settle(); });

      // 同一地址/同一寿命：服务端未推进窗口
      mocks.api.mockResolvedValueOnce(signedBatch("https://signed/old", EXPIRES, REFRESH));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
        await settle();
      });
      expect(mocks.api).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
      expect(mocks.api).toHaveBeenCalledTimes(2);
    });
  });

  it("refresh 期间换源：旧源的等待方以 undefined 结算，不悬挂", async () => {
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/first"));
    const nextKey = makeStorageKey("hook-signed-next", ".png");
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useFileAccessUrl(value),
      { initialProps: { value: KEY } },
    );
    await waitFor(() => expect(result.current.url).toBe("https://signed/first"));

    // 强制刷新的描述永不返回：等待方只能在源切换时被结算
    hangUntilSessionChange();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.refresh(); });
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/second"));
    rerender({ value: nextKey });

    await act(async () => { await expect(pending).resolves.toBeUndefined(); });
  });

  it("账号切换复位重试闩锁：同一地址在新账号下重新享有一次重试", async () => {
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/shared"));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.url).toBe("https://signed/shared"));

    // 同一地址重签仍是它：第一次重挂元素，随后闩锁命中（不再刷新）
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/shared"));
    let retried!: Promise<string | null>;
    act(() => { retried = result.current.retrySigned(); });
    await waitFor(() => expect(result.current.reloadToken).toBe(1));
    await act(async () => { await expect(retried).resolves.toBe("https://signed/shared"); });
    expect(await result.current.retrySigned()).toBeNull();

    // 新账号重新解析出同一地址：会话切换清空闩锁，重试预算重新武装。
    // 地址字符串与旧账号相同，必须同时等第三次描述完成，才能确认状态已重建
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/shared"));
    act(() => changeSession());
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledTimes(3);
      expect(result.current.url).toBe("https://signed/shared");
    });

    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/shared"));
    let retriedAgain!: Promise<string | null>;
    act(() => { retriedAgain = result.current.retrySigned(); });
    await waitFor(() => expect(result.current.reloadToken).toBe(2));
    await act(async () => { await expect(retriedAgain).resolves.toBe("https://signed/shared"); });
    expect(mocks.api).toHaveBeenCalledTimes(4);
  });

  it("账号切换取消在途请求：取消不记为失败（失败态不粘滞）", async () => {
    // 两次描述都挂起：取消与重新解析都无法靠「成功」把失败态盖回去——
    // 会话切换拒绝了在途 job（AbortError），组件此时尚未 abort 自己的 controller，
    // 若把取消记成失败，重新解析成功后失败态会一直粘着（面板遮罩永不消失）
    hangUntilSessionChange();
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    expect(result.current.url).toBeUndefined();

    act(() => changeSession());
    await act(async () => {});

    expect(result.current.failed).toBe(false);
    expect(result.current.url).toBeUndefined();
  });

  it("账号切换后重新解析（旧结果显示期间清空）", async () => {
    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/user-a"));
    const { result } = renderHook(() => useFileAccessUrl(KEY));
    await waitFor(() => expect(result.current.url).toBe("https://signed/user-a"));

    mocks.api.mockResolvedValueOnce(signedBatch("https://signed/user-b"));
    act(() => changeSession());
    await waitFor(() => expect(result.current.url).toBe("https://signed/user-b"));
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
});
