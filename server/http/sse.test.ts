import { describe, expect, it, vi } from "vitest";

import { closeAllSseConnections, createSseResponse } from "./sse";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSseResponse", () => {
  it("正常任务完成后从活跃连接注册表移除", async () => {
    const onDisconnect = vi.fn();
    const response = createSseResponse(
      new Request("http://localhost/events"),
      async () => undefined,
      { onDisconnect },
    );

    const result = await response.body!.getReader().read();
    expect(result.done).toBe(true);

    closeAllSseConnections();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("主动关闭时中止上游任务并结束 SSE 响应", async () => {
    const onDisconnect = vi.fn();
    let upstreamSignal: AbortSignal | undefined;
    const response = createSseResponse(
      new Request("http://localhost/events"),
      async ({ signal }) => {
        upstreamSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
      { onDisconnect },
    );

    await tick();
    closeAllSseConnections();

    expect(upstreamSignal?.aborted).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    await expect(response.body!.getReader().read()).resolves.toMatchObject({ done: true });
  });
});
