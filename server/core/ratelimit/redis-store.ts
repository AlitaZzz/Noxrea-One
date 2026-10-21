/**
 * Redis 滑动窗口限流存储。
 *
 * 每个业务键一个 ZSET：成员为请求唯一 id，score 为 Redis 服务端时间（毫秒）。
 * 判定与写入在同一段 Lua 中完成，保证多副本并发下计数原子；使用 Redis TIME
 * 而不是应用进程时钟，避免副本间时钟偏差影响窗口边界。
 *
 * 连接策略：限流是请求路径上的旁路依赖，Redis 抖动时必须快速失败而不是排队。
 * 因此关闭 offline queue 并设置命令超时；命令失败由上层统一按 fail-open 处理，
 * 连接错误只记日志（按固定间隔去重），不让未处理的 error 事件拖垮进程。
 */
import { randomUUID } from "node:crypto";

import IORedis, { type Redis } from "ioredis";

import { secondsToMs } from "@server/core/duration";
import { logger } from "@server/core/logger";

import { RATE_LIMIT_KEY_PREFIX } from "./constants";
import { createFailureLogThrottle } from "./log-throttle";
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

/** 单条命令超时：限流在请求路径上，Redis 慢响应必须快速失败，交由上层 fail-open。 */
const COMMAND_TIMEOUT_MS = 2_000;
/** 启动期建连超时：不可达即启动失败，不在后台无限重连。 */
const CONNECT_TIMEOUT_MS = 3_000;
/**
 * 连接中断时，已发出但未收到回复的命令在重连后最多重发一次（ioredis 在每次断连时
 * 按该值冲刷在途命令队列）；断连期间新发出的命令因关闭 offline queue 而立即失败。
 */
const MAX_RETRIES_PER_REQUEST = 1;

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

  /** 启动期建连并 PING：Redis 不可达时直接让启动失败，不带着不可用的限流进入服务态。 */
  static async connect(url: string): Promise<RedisRateLimitStore> {
    const client = new IORedis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    }) as RateLimitRedis;

    const shouldLogConnectionError = createFailureLogThrottle();
    client.on("error", (err) => {
      // 连接错误只记日志不抛：运行期瞬断由上层 fail-open 兜底，未处理的 error 事件会让进程崩溃。
      // ioredis 会持续重连并按退避反复触发该事件，日志同样按固定间隔去重。
      if (!shouldLogConnectionError()) return;
      logger.warn({ err }, "ratelimit redis connection error");
    });

    client.defineCommand("noxreaRateLimitCheck", {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });

    try {
      await client.connect();
      await client.ping();
    } catch (err) {
      // 建连 / 探测失败即启动失败：必须主动断开，否则客户端会在后台持续重连并占用句柄。
      client.disconnect();
      throw err;
    }
    return new RedisRateLimitStore(client);
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

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // 连接已断开时 quit() 会抛错；此时直接断开即可，不把停机失败抛给调用方。
      this.client.disconnect();
    }
  }
}
