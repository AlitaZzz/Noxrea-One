/**
 * 同键请求合并：单次生成、引用计数中止、过载/失败共享与条目移除
 * （specs/media-processing-concurrency.md 业务规则 5）。
 */
import { describe, expect, it, vi } from "vitest";

import { runSingleFlight } from "@server/core/single-flight";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("缩略图请求合并", () => {
  it("同键并发只触发一次生成，全部等待者拿到同一结果", async () => {
    const generate = vi.fn(async () => "result");
    const results = await Promise.all([
      runSingleFlight({ key: "shared", generate }),
      runSingleFlight({ key: "shared", generate }),
      runSingleFlight({ key: "shared", generate }),
    ]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(results).toEqual(["result", "result", "result"]);
  });

  it("leader 先中止不影响生成，其余等待者仍拿到结果", async () => {
    const deferredResult = deferred<string>();
    let genSignal!: AbortSignal;
    const controller = new AbortController();
    const leader = runSingleFlight({
      key: "leader-abort",
      signal: controller.signal,
      generate: (signal) => { genSignal = signal; return deferredResult.promise; },
    });
    const follower = runSingleFlight({ key: "leader-abort", generate: () => deferredResult.promise });

    await Promise.resolve();
    controller.abort();
    await expect(leader).rejects.toMatchObject({ name: "AbortError" });
    expect(genSignal.aborted).toBe(false);

    deferredResult.resolve("done");
    await expect(follower).resolves.toBe("done");
  });

  it("全部等待者中止后才取消生成", async () => {
    const deferredResult = deferred<string>();
    let genSignal!: AbortSignal;
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = runSingleFlight({
      key: "all-abort",
      signal: c1.signal,
      generate: (signal) => { genSignal = signal; return deferredResult.promise; },
    });
    const p2 = runSingleFlight({ key: "all-abort", signal: c2.signal, generate: () => deferredResult.promise });

    await Promise.resolve();
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(genSignal.aborted).toBe(true);
  });

  it("过载拒绝由全体等待者共享，条目移除后可重新生成", async () => {
    const busy = new MediaPoolBusyError("sharp", "global", "queue_full");
    let calls = 0;
    const first = runSingleFlight({
      key: "busy",
      generate: async () => { calls += 1; throw busy; },
    });
    const second = runSingleFlight({ key: "busy", generate: async () => "unused" });

    await expect(first).rejects.toBe(busy);
    await expect(second).rejects.toBe(busy);
    expect(calls).toBe(1);

    await expect(runSingleFlight({ key: "busy", generate: async () => "again" })).resolves.toBe("again");
  });

  it("生成失败不做负缓存，下一次请求重新生成", async () => {
    let calls = 0;
    const first = runSingleFlight({
      key: "failure",
      generate: async () => { calls += 1; if (calls === 1) throw new Error("boom"); return "ok"; },
    });
    const second = runSingleFlight({ key: "failure", generate: async () => "unused" });

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(calls).toBe(1);

    await expect(runSingleFlight({ key: "failure", generate: async () => "ok2" })).resolves.toBe("ok2");
  });

  it("中止原因为字符串（@hono/node-server 断开）时等待者仍以 AbortError 退出，原因放进 cause", async () => {
    const reason = "Client connection prematurely closed.";
    const pending = deferred<string>();
    const controller = new AbortController();
    const waiter = runSingleFlight({ key: "string-reason", signal: controller.signal, generate: () => pending.promise });
    const follower = runSingleFlight({ key: "string-reason", generate: () => pending.promise });

    await Promise.resolve();
    controller.abort(reason);
    await expect(waiter).rejects.toMatchObject({ name: "AbortError", cause: reason });

    const preAborted = new AbortController();
    preAborted.abort(reason);
    await expect(runSingleFlight({ key: "string-reason", signal: preAborted.signal, generate: () => pending.promise }))
      .rejects.toMatchObject({ name: "AbortError", cause: reason });

    pending.resolve("done");
    await expect(follower).resolves.toBe("done");
  });

  it("预中止请求不进入合并也不启动生成", async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(async () => "x");
    await expect(runSingleFlight({ key: "pre-abort", signal: controller.signal, generate }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("全部等待者中止后到达的同键请求发起新的生成，而不是加入正在中止的生成", async () => {
    const controller = new AbortController();
    const cancelled = runSingleFlight({
      key: "rejoin-after-abort",
      signal: controller.signal,
      generate: (signal) => new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const fresh = vi.fn(async () => "fresh");
    await expect(runSingleFlight({ key: "rejoin-after-abort", generate: fresh })).resolves.toBe("fresh");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("旧生成收尾时不会误删新生成的在途条目", async () => {
    const oldController = new AbortController();
    const oldRun = deferred<string>();
    const old = runSingleFlight({
      key: "stale-cleanup",
      signal: oldController.signal,
      generate: () => oldRun.promise,
    });
    await Promise.resolve();
    oldController.abort();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });

    const newRun = deferred<string>();
    const fresh = vi.fn(() => newRun.promise);
    const first = runSingleFlight({ key: "stale-cleanup", generate: fresh });
    oldRun.resolve("late");
    await Promise.resolve();
    await Promise.resolve();
    const joiner = vi.fn(async () => "unused");
    const second = runSingleFlight({ key: "stale-cleanup", generate: joiner });
    newRun.resolve("new");

    await expect(first).resolves.toBe("new");
    await expect(second).resolves.toBe("new");
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(joiner).not.toHaveBeenCalled();
  });

  it("不同键各自独立生成", async () => {
    const results = await Promise.all([
      runSingleFlight({ key: "k1", generate: async () => "a" }),
      runSingleFlight({ key: "k2", generate: async () => "b" }),
    ]);
    expect(results).toEqual(["a", "b"]);
  });
});
