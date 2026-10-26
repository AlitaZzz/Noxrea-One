/**
 * 业务限流服务：策略键名 / 维度映射、结果透传、Redis 故障 fail-open。
 * 滑动窗口本身由 redis-store 的 Lua 实现（真 Redis 集成测试见 redis-store.integration.test.ts）；
 * 这里用替身存储锁定服务层契约，不依赖外部 Redis。
 *
 * 连接已由 `core/redis` 统一提供，本层只负责在已建连的客户端上挂载计数器
 * （specs/auth-request-verification.md 规则 5）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  requireClient: vi.fn(() => "redis-client"),
}));

vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/core/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@server/core/redis/client", () => ({ requireRequestPathRedis: mocks.requireClient }));
vi.mock("@server/core/ratelimit/redis-store", () => ({
  RedisRateLimitStore: { attach: mocks.attach },
}));

import {
  checkGenerateRateLimit,
  checkLoginRateLimit,
  checkMediaEditRateLimit,
  checkRegisterRateLimit,
  closeRateLimit,
  initRateLimit,
} from "@server/core/ratelimit";
import type { RateLimitQuota, RateLimitResult, RateLimitStore } from "@server/core/ratelimit";
import { resetTestSettings } from "../../helpers/settings";

class FakeStore implements RateLimitStore {
  readonly calls: Array<{ key: string; quota: RateLimitQuota }> = [];
  result: RateLimitResult = { allowed: true };
  failure: Error | null = null;

  async check(key: string, quota: RateLimitQuota): Promise<RateLimitResult> {
    this.calls.push({ key, quota });
    if (this.failure) throw this.failure;
    return this.result;
  }
}

let store: FakeStore;

beforeEach(() => {
  store = new FakeStore();
  mocks.attach.mockReset();
  mocks.requireClient.mockClear();
  mocks.attach.mockReturnValue(store);
  resetTestSettings();
});

afterEach(async () => {
  await closeRateLimit();
});

describe("业务维度与配额映射", () => {
  it("登录 / 注册按 IP 计数，读取各自配额", async () => {
    await initRateLimit();

    await checkLoginRateLimit("203.0.113.10");
    await checkRegisterRateLimit("203.0.113.10");

    expect(store.calls).toEqual([
      { key: "login:203.0.113.10", quota: { maxRequests: 5, windowSeconds: 60 } },
      { key: "register:203.0.113.10", quota: { maxRequests: 3, windowSeconds: 3600 } },
    ]);
  });

  it("生成 / 媒体编辑按用户计数，读取各自配额", async () => {
    await initRateLimit();

    await checkGenerateRateLimit(42);
    await checkMediaEditRateLimit(42);

    expect(store.calls).toEqual([
      { key: "generate:42", quota: { maxRequests: 20, windowSeconds: 60 } },
      { key: "media-edit:42", quota: { maxRequests: 20, windowSeconds: 60 } },
    ]);
  });

  it("配额来自 system_settings，而非调用方数字", async () => {
    resetTestSettings({
      "rate_limit.login_ip_max_requests": 9,
      "rate_limit.login_window_seconds": 120,
      "rate_limit.generate_user_max_requests": 4,
      "rate_limit.generate_window_seconds": 30,
    });
    await initRateLimit();

    await checkLoginRateLimit("198.51.100.1");
    await checkGenerateRateLimit(7);

    expect(store.calls).toEqual([
      { key: "login:198.51.100.1", quota: { maxRequests: 9, windowSeconds: 120 } },
      { key: "generate:7", quota: { maxRequests: 4, windowSeconds: 30 } },
    ]);
  });
});

describe("结果与故障策略", () => {
  it("超限结果原样透传（含 Retry-After 秒数）", async () => {
    store.result = { allowed: false, retryAfterSeconds: 30 };
    await initRateLimit();

    await expect(checkLoginRateLimit("203.0.113.10")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
  });

  it("存储故障时 fail-open 放行", async () => {
    store.failure = new Error("redis down");
    await initRateLimit();

    await expect(checkLoginRateLimit("203.0.113.10")).resolves.toEqual({ allowed: true });
  });
});

describe("初始化生命周期", () => {
  it("初始化后在共享连接上挂载计数器，关闭后拒绝服务", async () => {
    await initRateLimit();

    expect(mocks.requireClient).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledWith("redis-client");
    await expect(checkLoginRateLimit("203.0.113.10")).resolves.toEqual({ allowed: true });

    await closeRateLimit();
    await expect(checkLoginRateLimit("203.0.113.10")).rejects.toThrow(/not initialized/);
  });

  it("重复初始化不再挂载", async () => {
    await Promise.all([initRateLimit(), initRateLimit()]);
    await initRateLimit();

    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("请求路径连接未就绪时初始化失败（启动流程不变量）", async () => {
    mocks.requireClient.mockImplementationOnce(() => {
      throw new Error("Request-path Redis is not initialized");
    });

    await expect(initRateLimit()).rejects.toThrow(/not initialized/);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});
