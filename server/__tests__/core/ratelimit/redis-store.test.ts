/**
 * RedisRateLimitStore 启动探测的失败路径：建连 / PING 失败必须主动断开客户端，
 * 否则 ioredis 会在后台持续重连并占用句柄。真 Redis 的正常路径见集成测试。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  ping: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  defineCommand: vi.fn(),
}));

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on = mocks.on;
    defineCommand = mocks.defineCommand;
    connect = mocks.connect;
    ping = mocks.ping;
    disconnect = mocks.disconnect;
  },
}));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { RedisRateLimitStore } from "@server/core/ratelimit/redis-store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RedisRateLimitStore.connect（启动探测失败）", () => {
  it("建连失败时断开客户端", async () => {
    mocks.connect.mockRejectedValue(new Error("connect failed"));

    await expect(RedisRateLimitStore.connect("redis://localhost:6379")).rejects.toThrow(
      "connect failed",
    );
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("PING 失败时断开客户端", async () => {
    mocks.connect.mockResolvedValue(undefined);
    mocks.ping.mockRejectedValue(new Error("auth failed"));

    await expect(RedisRateLimitStore.connect("redis://localhost:6379")).rejects.toThrow(
      "auth failed",
    );
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
