/**
 * RedisRateLimitStore 在共享请求路径连接上的挂载契约：Lua 命令注册到传入的连接、
 * 业务键加限流前缀、Lua 返回值换算成限流结果。真 Redis 行为见集成测试。
 */
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_KEY_PREFIX } from "@server/core/ratelimit/constants";
import { RedisRateLimitStore } from "@server/core/ratelimit/redis-store";
import type { Redis } from "ioredis";

interface FakeCommandClient {
  defineCommand: (name: string, def: { numberOfKeys: number; lua: string }) => void;
  noxreaRateLimitCheck?: (...args: unknown[]) => Promise<[number, number]>;
}

function fakeClient(result: [number, number]) {
  const calls: unknown[][] = [];
  const client: FakeCommandClient = {
    defineCommand: (name, def) => {
      expect(def.numberOfKeys).toBe(1);
      expect(def.lua).toContain("ZREMRANGEBYSCORE");
      client[name as "noxreaRateLimitCheck"] = async (...args) => {
        calls.push(args);
        return result;
      };
    },
  };
  return { client, calls };
}

describe("RedisRateLimitStore.attach", () => {
  it("在传入连接上定义命令，业务键加限流前缀", async () => {
    const { client, calls } = fakeClient([1, 0]);
    const store = RedisRateLimitStore.attach(client as unknown as Redis);

    await expect(store.check("login:1.2.3.4", { maxRequests: 5, windowSeconds: 60 }))
      .resolves.toEqual({ allowed: true });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${RATE_LIMIT_KEY_PREFIX}login:1.2.3.4`);
    expect(calls[0][1]).toBe(5);
    expect(calls[0][2]).toBe(60_000);
    expect(typeof calls[0][3]).toBe("string");
  });

  it("拒绝时透传剩余秒数", async () => {
    const { client } = fakeClient([0, 7]);
    const store = RedisRateLimitStore.attach(client as unknown as Redis);

    await expect(store.check("generate:9", { maxRequests: 1, windowSeconds: 10 }))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 7 });
  });
});

describe("RedisRateLimitStore.attach 幂等", () => {
  it("同一连接上重复挂载覆盖同名命令，不抛错", () => {
    const { client } = fakeClient([1, 0]);
    const redis = client as unknown as Redis;

    expect(() => {
      RedisRateLimitStore.attach(redis);
      RedisRateLimitStore.attach(redis);
    }).not.toThrow();
  });
});
