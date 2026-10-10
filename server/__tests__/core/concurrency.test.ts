import { describe, expect, it } from "vitest";

import { waitForUserConcurrency } from "@server/core/ratelimit/concurrency";

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
