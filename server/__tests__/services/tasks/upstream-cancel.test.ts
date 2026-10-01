/**
 * 上游取消 best-effort 语义测试：
 * 缺 upstreamTaskId / 缺 provider / 协议未声明取消能力 → 跳过且不发请求；
 * 能力齐备 → 按 buildCancelRequest 构建的请求发出；请求失败不抛错（不阻断本地取消）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeout, getProvider } = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("@server/core/http-client", () => ({ fetchWithTimeout }));
vi.mock("@server/crud/model-config", () => ({ getProvider }));
vi.mock("@server/services/model-config", () => ({
  hostFromBaseUrl: (url: string) => new URL(url).hostname,
  resolveProviderEndpoints: vi.fn(() => undefined),
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: vi.fn(),
  errText: (e: unknown) => String(e),
}));

import { registerProtocol } from "@server/services/protocols/base";
import { cancelUpstreamTask } from "@server/services/tasks/upstream-cancel";

const input = {
  taskId: "t-1",
  userId: 1,
  upstreamTaskId: "u-1",
  providerId: 7,
};

beforeEach(() => {
  fetchWithTimeout.mockReset();
  getProvider.mockReset();
});

describe("cancelUpstreamTask", () => {
  it("缺 upstreamTaskId（上游未受理）→ 跳过且不发请求", async () => {
    await cancelUpstreamTask({ taskId: "t-1", userId: 1, providerId: 7 });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("provider 缺失 → 跳过且不发请求", async () => {
    getProvider.mockResolvedValue(null);
    await cancelUpstreamTask(input);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("协议未声明 buildCancelRequest 能力 → 跳过且不发请求", async () => {
    getProvider.mockResolvedValue({ baseUrl: "https://api.test/v1", apiKey: "k", protocol: "plain" });
    registerProtocol("plain", { name: "plain" });
    await cancelUpstreamTask(input);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("能力齐备 → 按协议构建的请求发出（含鉴权头）", async () => {
    getProvider.mockResolvedValue({ baseUrl: "https://api.test/v1", apiKey: "key-1", protocol: "cancelable" });
    registerProtocol("cancelable", {
      name: "cancelable",
      buildCancelRequest: (baseUrl, id, apiKey) => ({
        url: `${baseUrl}/tasks/${id}/cancel`,
        method: "POST" as const,
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    });
    fetchWithTimeout.mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await expect(cancelUpstreamTask(input)).resolves.toBeUndefined();
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.test/v1/tasks/u-1/cancel",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer key-1" } })
    );
  });

  it("取消请求失败 → 不抛错（best-effort，只记日志）", async () => {
    getProvider.mockResolvedValue({ baseUrl: "https://api.test/v1", apiKey: "k", protocol: "cancelable" });
    registerProtocol("cancelable", {
      name: "cancelable",
      buildCancelRequest: (baseUrl, id) => ({ url: `${baseUrl}/tasks/${id}/cancel`, method: "POST" as const, headers: {} }),
    });
    fetchWithTimeout.mockRejectedValue(new Error("network down"));

    await expect(cancelUpstreamTask(input)).resolves.toBeUndefined();
  });
});
