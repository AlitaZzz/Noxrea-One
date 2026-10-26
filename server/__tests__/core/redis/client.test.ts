/**
 * 请求路径 Redis 建连契约（specs/auth-request-verification.md 规则 5）：
 * 启动期建连 / PING 失败必须主动断开客户端（否则 ioredis 在后台持续重连占句柄）；
 * 成功后可被限流与鉴权快照取用；停机断开后回到未初始化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  ping: vi.fn(),
  disconnect: vi.fn(),
  quit: vi.fn(),
  on: vi.fn(),
}));

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on = mocks.on;
    connect = mocks.connect;
    ping = mocks.ping;
    disconnect = mocks.disconnect;
    quit = mocks.quit;
  },
}));
vi.mock("@server/core/config", () => ({ getConfig: () => ({ REDIS_URL: "redis://test" }) }));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  closeRequestPathRedis,
  getRequestPathRedis,
  initRequestPathRedis,
  requireRequestPathRedis,
} from "@server/core/redis/client";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.ping.mockResolvedValue("PONG");
  mocks.quit.mockResolvedValue("OK");
});

afterEach(async () => {
  await closeRequestPathRedis();
});

describe("initRequestPathRedis", () => {
  it("建连失败时断开客户端并让启动失败", async () => {
    mocks.connect.mockRejectedValue(new Error("connect failed"));

    await expect(initRequestPathRedis()).rejects.toThrow("connect failed");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(getRequestPathRedis()).toBeNull();
  });

  it("PING 失败时断开客户端并让启动失败", async () => {
    mocks.ping.mockRejectedValue(new Error("auth failed"));

    await expect(initRequestPathRedis()).rejects.toThrow("auth failed");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(getRequestPathRedis()).toBeNull();
  });

  it("成功后可取用，重复初始化不再建连", async () => {
    await initRequestPathRedis();
    const client = getRequestPathRedis();

    expect(client).not.toBeNull();
    expect(requireRequestPathRedis()).toBe(client);

    await initRequestPathRedis();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("未初始化时 require 抛错，get 返回 null（鉴权快照据此回源数据库）", () => {
    expect(getRequestPathRedis()).toBeNull();
    expect(() => requireRequestPathRedis()).toThrow(/not initialized/);
  });

  it("停机时 quit 连接，之后回到未初始化", async () => {
    await initRequestPathRedis();
    await closeRequestPathRedis();

    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(getRequestPathRedis()).toBeNull();
  });
});
