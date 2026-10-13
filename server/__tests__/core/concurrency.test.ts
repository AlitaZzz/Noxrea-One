import { describe, expect, it } from "vitest";

import { BoundedGate, waitForUserConcurrency } from "@server/core/ratelimit/concurrency";

 describe("并发租约取消", () => {
  it("预取消请求立即拒绝，不占繁忙用户的 pending 名额", async () => {
    const release = await waitForUserConcurrency("pre-abort", 1, 1, undefined, 1);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(waitForUserConcurrency("pre-abort", 1, 1, controller.signal, 1))
        .rejects.toMatchObject({ name: "AbortError" });
      const queued = waitForUserConcurrency("pre-abort", 1, 1, undefined, 1);
      release();
      const releaseQueued = await queued;
      releaseQueued();
    } finally {
      release();
    }
  });

  it("入队后取消同样立即拒绝，并可重新接纳等待者", async () => {
    const release = await waitForUserConcurrency("queued-abort", 2, 1, undefined, 1);
    const controller = new AbortController();
    const cancelled = waitForUserConcurrency("queued-abort", 2, 1, controller.signal, 1);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const queued = waitForUserConcurrency("queued-abort", 2, 1, undefined, 1);
    release();
    (await queued)();
  });
});

describe("有界并发门（BoundedGate）", () => {
  it("上限内直接获取，超额 FIFO 排队", async () => {
    const gate = new BoundedGate("gate-fifo", 1);
    const order: string[] = [];
    const releaseA = await gate.acquire();
    const b = gate.acquire().then((release) => { order.push("b"); return release; });
    const c = gate.acquire().then((release) => { order.push("c"); return release; });
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseA();
    (await b)();
    expect(order).toEqual(["b"]);

    (await b)();
    (await c)();
    expect(order).toEqual(["b", "c"]);
  });

  it("队列满立即拒绝（reason=queue_full）", async () => {
    const gate = new BoundedGate("gate-full", 1);
    const release = await gate.acquire();
    await expect(gate.acquire({ maxPending: 0 })).rejects.toMatchObject({
      name: "GateRejectedError",
      reason: "queue_full",
      message: expect.stringContaining("gate-full"),
    });
    release();
  });

  it("排队超过等待时限出队拒绝（reason=wait_timeout）", async () => {
    const gate = new BoundedGate("gate-wait", 1);
    const release = await gate.acquire();
    await expect(gate.acquire({ maxWaitMs: 5 })).rejects.toMatchObject({
      name: "GateRejectedError",
      reason: "wait_timeout",
    });
    release();
  });

  it("排队期间中止立即出队且不占槽位", async () => {
    const gate = new BoundedGate("gate-abort", 1);
    const controller = new AbortController();
    const release = await gate.acquire();
    const queued = gate.acquire({ signal: controller.signal });
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(gate.pendingCount).toBe(0);

    release();
    const again = await gate.acquire();
    again();
  });

  it("中止原因不是 Error（如 @hono/node-server 断开时的字符串）也以 AbortError 拒绝，原因放进 cause", async () => {
    const reason = "Client connection prematurely closed.";
    const gate = new BoundedGate("gate-string-reason", 1);
    const release = await gate.acquire();

    const queuedController = new AbortController();
    const queued = gate.acquire({ signal: queuedController.signal });
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError", cause: reason });
    queuedController.abort(reason);
    await rejected;

    const preAborted = new AbortController();
    preAborted.abort(reason);
    await expect(gate.acquire({ signal: preAborted.signal }))
      .rejects.toMatchObject({ name: "AbortError", cause: reason });
    release();
  });

  it("重复释放无副作用，不产生负数槽位", async () => {
    const gate = new BoundedGate("gate-idempotent", 1);
    const release = await gate.acquire();
    release();
    release();
    const again = await gate.acquire();
    again();
  });

  it("maxPending=0：有空槽直接放行，槽位满才拒绝", async () => {
    const gate = new BoundedGate("gate-no-queue", 1);
    const release = await gate.acquire({ maxPending: 0 });
    await expect(gate.acquire({ maxPending: 0 })).rejects.toMatchObject({ reason: "queue_full" });
    expect(gate.pendingCount).toBe(0);
    release();
    (await gate.acquire({ maxPending: 0 }))();
  });

  it("等待超时与排队中止都会清掉定时器 / 监听，之后可正常放行", async () => {
    const gate = new BoundedGate("gate-cleanup", 1);
    const release = await gate.acquire();
    const controller = new AbortController();
    const aborted = expect(gate.acquire({ signal: controller.signal, maxWaitMs: 60_000 }))
      .rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    await expect(gate.acquire({ maxWaitMs: 5 })).rejects.toMatchObject({ reason: "wait_timeout" });
    expect(gate.pendingCount).toBe(0);

    const queued = gate.acquire();
    release();
    (await queued)();
  });
});

describe("按用户并发租约的释放", () => {
  it("重复释放旧租约不会删掉同一用户随后新建的门，并发上限不被绕过", async () => {
    const first = await waitForUserConcurrency("double-release", 9, 1);
    first();
    const second = await waitForUserConcurrency("double-release", 9, 1);
    first();

    let thirdAcquired = false;
    const third = waitForUserConcurrency("double-release", 9, 1).then((release) => {
      thirdAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thirdAcquired).toBe(false);

    second();
    (await third)();
    expect(thirdAcquired).toBe(true);
  });
});

describe("按用户并发租约的过载拒绝", () => {
  it("队列深度超限抛 GateRejectedError(queue_full)，调用方据此回 429", async () => {
    const release = await waitForUserConcurrency("overload", 7, 1, undefined, 1);
    const queued = waitForUserConcurrency("overload", 7, 1, undefined, 1);
    await expect(waitForUserConcurrency("overload", 7, 1, undefined, 1)).rejects.toMatchObject({
      name: "GateRejectedError",
      reason: "queue_full",
    });
    release();
    (await queued)();
  });
});
