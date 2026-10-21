/**
 * Redis 滑动窗口限流存储真 Redis 集成测试。
 * 隔离策略：TEST_REDIS_URL 应指向专用 DB index（如 /15）；清理只删除本前缀键，
 * 禁止对共享实例 flushdb。未设置 TEST_REDIS_URL 时整组跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import IORedis from "ioredis";

import { RATE_LIMIT_KEY_PREFIX } from "@server/core/ratelimit/constants";
import { RedisRateLimitStore } from "@server/core/ratelimit/redis-store";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!TEST_REDIS_URL)("RedisRateLimitStore（真 Redis）", () => {
  let store: RedisRateLimitStore;
  let admin: IORedis;

  beforeAll(async () => {
    store = await RedisRateLimitStore.connect(TEST_REDIS_URL!);
    admin = new IORedis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    if (admin) {
      let cursor = "0";
      do {
        const [next, keys] = await admin.scan(
          cursor,
          "MATCH",
          `${RATE_LIMIT_KEY_PREFIX}it:*`,
          "COUNT",
          200,
        );
        cursor = next;
        if (keys.length > 0) await admin.del(...keys);
      } while (cursor !== "0");
      await admin.quit();
    }
    await store?.close();
  });

  it("窗口内达到上限后拒绝，并给出剩余秒数；窗口滑过后恢复", async () => {
    const key = `it:login:${Date.now()}`;
    const quota = { maxRequests: 2, windowSeconds: 1 };

    await expect(store.check(key, quota)).resolves.toEqual({ allowed: true });
    await expect(store.check(key, quota)).resolves.toEqual({ allowed: true });
    await expect(store.check(key, quota)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: expect.any(Number),
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(store.check(key, quota)).resolves.toEqual({ allowed: true });
  }, 10_000);

  it("不同业务键互不影响", async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const quota = { maxRequests: 1, windowSeconds: 60 };

    await expect(store.check(`it:a:${suffix}`, quota)).resolves.toEqual({ allowed: true });
    await expect(store.check(`it:a:${suffix}`, quota)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: expect.any(Number),
    });
    await expect(store.check(`it:b:${suffix}`, quota)).resolves.toEqual({ allowed: true });
  }, 10_000);
});
