/**
 * Redis 滑动窗口限流存储。
 *
 * 每个业务键一个 ZSET：成员为请求唯一 id，score 为 Redis 服务端时间（毫秒）。
 * 判定与写入在同一段 Lua 中完成，保证多副本并发下计数原子；使用 Redis TIME
 * 而不是应用进程时钟，避免副本间时钟偏差影响窗口边界。
 *
 * 连接由 `core/redis` 提供（与鉴权快照共用请求路径连接）：本存储只负责键命名、
 * 命令定义与结果换算，不持有连接生命周期。
 */
import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import { secondsToMs } from "@server/core/duration";

import { RATE_LIMIT_KEY_PREFIX } from "./constants";
import type { RateLimitQuota, RateLimitResult, RateLimitStore } from "./types";

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local maxRequests = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]

local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count < maxRequests then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfter = math.ceil((tonumber(oldest[2]) + windowMs - now) / 1000)
if retryAfter < 1 then retryAfter = 1 end
return {0, retryAfter}
`;

interface RateLimitRedis extends Redis {
  noxreaRateLimitCheck(
    key: string,
    maxRequests: number,
    windowMs: number,
    member: string,
  ): Promise<[number, number]>;
}

export class RedisRateLimitStore implements RateLimitStore {
  private constructor(private readonly client: RateLimitRedis) {}

  /** 在已建立的请求路径连接上注册 Lua 命令（重复注册会覆盖同名命令，幂等）。 */
  static attach(client: Redis): RedisRateLimitStore {
    const conn = client as RateLimitRedis;
    conn.defineCommand("noxreaRateLimitCheck", {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });
    return new RedisRateLimitStore(conn);
  }

  async check(key: string, quota: RateLimitQuota): Promise<RateLimitResult> {
    const [allowed, retryAfter] = await this.client.noxreaRateLimitCheck(
      `${RATE_LIMIT_KEY_PREFIX}${key}`,
      quota.maxRequests,
      secondsToMs(quota.windowSeconds),
      randomUUID(),
    );
    return allowed === 1
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: retryAfter };
  }
}
