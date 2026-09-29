/**
 * 场景化 HTTP 客户端测试。
 * 锁定三段超时（headers / body idle / overall）各自触发、
 * 数据到达重置 idle、外部 signal 合并、流 cancel/收尾的定时器清理。
 *
 * 假 fetch 模拟 undici 语义：controller.abort(reason) 会以 reason 拒绝在途
 * body 读取——通过监听传入的 signal 并 error 底层流实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock("@server/core/config", () => ({
  getConfig: mocks.getConfig,
  isProxyRoutingEnabled: vi.fn(() => false),
}));
vi.mock("@server/core/ssrf", () => ({
  getSsrfAgent: vi.fn(() => ({})),
}));

import { fetchWithTimeout, HttpTimeoutError } from "./index";

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * 模拟 undici 的 abort 语义：controller.abort 后在途的 body 读取以 signal.reason 拒绝。
 * mode:
 *  - "stalled"：响应头已返回，body 永远不出数据（等 abort 拒绝）
 *  - "hang"：连响应头都不返回（等 abort 拒绝 fetch 本身）
 *  - "chunks"：按 intervalMs 逐个吐 chunks 后关闭
 */
function makeFetch(mode: "stalled" | "hang" | "chunks", chunks: Uint8Array[] = [], intervalMs = 60) {
  return vi.fn((_url: string | URL, init?: RequestInit): Promise<Response> => {
    const signal = init!.signal! as AbortSignal;
    if (mode === "hang") {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        signal.addEventListener("abort", () => ctrl.error(signal.reason), { once: true });
        if (mode === "stalled") return;
        let i = 0;
        const tick = () => {
          if (signal.aborted || closed) return;
          if (i < chunks.length) {
            ctrl.enqueue(chunks[i++]);
            setTimeout(tick, intervalMs);
          } else {
            ctrl.close();
          }
        };
        setTimeout(tick, intervalMs);
      },
      cancel() {
        // 消费者取消后停止滴漏，避免定时器回调里对已关闭流入 enqueue
        closed = true;
      },
    });
    return Promise.resolve(new Response(body));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.getConfig.mockReturnValue({ HTTP_BODY_IDLE_TIMEOUT: 60 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout 三段超时", () => {
  it("headers 超时：响应头迟迟不到 → fetch 以 UND_ERR_HEADERS_TIMEOUT 拒绝", async () => {
    vi.stubGlobal("fetch", makeFetch("hang"));

    const promise = fetchWithTimeout("http://upstream.test/x", { timeoutMs: 100 });
    const settled = expect(promise).rejects.toMatchObject({
      name: "TimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
  });

  it("body idle 超时：响应停摆 → 读取以 UND_ERR_BODY_TIMEOUT 拒绝", async () => {
    vi.stubGlobal("fetch", makeFetch("stalled"));

    const res = await fetchWithTimeout("http://upstream.test/x", {
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 100,
    });
    const textPromise = res.text();
    const settled = expect(textPromise).rejects.toMatchObject({
      name: "TimeoutError",
      code: "UND_ERR_BODY_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
  });

  it("overall 超时：慢滴漏（chunk 间隔远小于 idle）被总时长上限终止", async () => {
    // chunk 每 60ms 一个，idle 需 1000ms 才触发；overall 200ms 先到
    vi.stubGlobal("fetch", makeFetch("chunks", [enc("a"), enc("b"), enc("c")], 60));

    const res = await fetchWithTimeout("http://upstream.test/x", {
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 1000,
      overallTimeoutMs: 200,
    });
    const textPromise = res.text();
    const settled = expect(textPromise).rejects.toMatchObject({
      name: "TimeoutError",
      code: "UND_ERR_BODY_TIMEOUT",
      message: expect.stringContaining("overall"),
    });
    await vi.advanceTimersByTimeAsync(200);
    await settled;
  });

  it("数据到达重置 idle 计时：间隔小于 idle 的滴漏正常读完", async () => {
    vi.stubGlobal("fetch", makeFetch("chunks", [enc("a"), enc("b"), enc("c")], 60));

    const res = await fetchWithTimeout("http://upstream.test/x", {
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 100,
      overallTimeoutMs: 10_000,
    });
    const textPromise = res.text();
    await vi.advanceTimersByTimeAsync(400);
    await expect(textPromise).resolves.toBe("abc");
  });
});

describe("fetchWithTimeout 信号合并与资源收尾", () => {
  it("外部 signal 中止在途 body 读取 → 以外部 reason 拒绝（非 HttpTimeoutError）", async () => {
    vi.stubGlobal("fetch", makeFetch("stalled"));

    const external = new AbortController();
    const res = await fetchWithTimeout("http://upstream.test/x", {
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 10_000,
      signal: external.signal,
    });
    const textPromise = res.text();
    const err = new Error("client aborted");
    external.abort(err);
    await expect(textPromise).rejects.toBe(err);
  });

  it("消费者提前 cancel 流 → overall 定时器清理，不再触发 abort", async () => {
    vi.stubGlobal("fetch", makeFetch("chunks", [enc("a"), enc("b"), enc("c")], 10));

    const res = await fetchWithTimeout("http://upstream.test/x", {
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 500,
      overallTimeoutMs: 5000,
    });
    const reader = res.body!.getReader();
    await vi.advanceTimersByTimeAsync(10);
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();

    // 越过 overall 与 idle 期限：定时器已清，无 abort、无未处理拒绝
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fetch 自身失败 → 定时器与外部监听清理后原样抛出", async () => {
    const err = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(err)));

    const external = new AbortController();
    await expect(
      fetchWithTimeout("http://upstream.test/x", {
        timeoutMs: 5000,
        overallTimeoutMs: 5000,
        signal: external.signal,
      })
    ).rejects.toBe(err);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    // 外部 signal 未被内部 abort 污染
    expect(external.signal.aborted).toBe(false);
  });

  it("204 无 body → 不包装看门狗，原样透传", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));

    const res = await fetchWithTimeout("http://upstream.test/x", {
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 100,
      overallTimeoutMs: 5000,
    });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("HttpTimeoutError", () => {
  it("name=TimeoutError + undici 风格 code，供上层分类识别", () => {
    const err = new HttpTimeoutError("boom", "UND_ERR_BODY_TIMEOUT");
    expect(err.name).toBe("TimeoutError");
    expect(err.code).toBe("UND_ERR_BODY_TIMEOUT");
    expect(err).toBeInstanceOf(Error);
  });
});
