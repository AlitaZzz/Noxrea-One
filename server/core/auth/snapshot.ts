/**
 * 鉴权快照（specs/auth-request-verification.md）。
 *
 * 每个已登录请求都要校验「账号是否可用」与「凭据版本是否仍是当前版本」。这两项
 * 存在 Redis 快照里，稳态请求不再回源数据库；改密 / 禁用等写路径在提交后覆盖
 * 快照，吊销在下一个请求即对所有实例生效。
 *
 * 正确性优先于缓存：
 * - 读取用 `SET NX` 回填：键已存在时以键内值为准，读路径永远不会用自己查到的旧值
 *   覆盖写路径刚写入的新值；键在回填途中消失（错过竞争、TTL 到期）时也不写回，
 *   不重建一次「查库那一刻」的快照；
 * - Redis 不可用时直接回源数据库（等同引入快照之前的成本），不重试、不排队、不做负缓存。
 */
import type { Redis } from "ioredis";

import { prisma } from "@server/core/database/client";
import { metrics } from "@server/core/metrics";
import { logger } from "@server/core/logger";
import { getRequestPathRedis } from "@server/core/redis/client";
import { createFailureLogThrottle } from "@server/core/redis/log-throttle";
import { runSingleFlight } from "@server/core/single-flight";

/**
 * 快照寿命（秒）：失效机制完全失灵时的吊销延迟上界，也是「绕过应用直接改库」
 * 的陈旧窗口上限。取 60 秒意味着每活跃用户每分钟最多回源一次。
 */
export const AUTH_SNAPSHOT_TTL_SECONDS = 60;

const KEY_PREFIX = "noxrea:auth:snap:";

/** 鉴权判定需要的全部账号状态；画像字段（用户名/头像/主题/语言）不进快照。 */
interface AuthSnapshot {
  readonly tokenVersion: number;
  readonly isActive: boolean;
}

/** 写路径掌握的权威状态（数据库提交后的用户行子集）。 */
interface AuthSnapshotSource extends AuthSnapshot {
  readonly id: number;
}

const shouldLogFailure = createFailureLogThrottle();

function keyOf(userId: number): string {
  return `${KEY_PREFIX}${userId}`;
}

/** 快照形态校验：无法解析或字段缺失按未命中处理，由回源覆盖。 */
function parseSnapshot(raw: string): AuthSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AuthSnapshot>;
    if (typeof parsed.tokenVersion !== "number" || !Number.isInteger(parsed.tokenVersion)) {
      return null;
    }
    if (typeof parsed.isActive !== "boolean") return null;
    return { tokenVersion: parsed.tokenVersion, isActive: parsed.isActive };
  } catch {
    return null;
  }
}

function serialize(snapshot: AuthSnapshot): string {
  return JSON.stringify({ tokenVersion: snapshot.tokenVersion, isActive: snapshot.isActive });
}

function logFailure(err: unknown, userId: number): void {
  if (!shouldLogFailure()) return;
  logger.warn({ err, userId }, "auth snapshot unavailable; falling back to database");
}

async function loadFromDatabase(userId: number): Promise<AuthSnapshot | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, tokenVersion: true },
  });
  return row ? { tokenVersion: row.tokenVersion, isActive: row.isActive } : null;
}

/**
 * 回填快照：只有键不存在时才写入。若写路径已经写入更新的状态，`NX` 失败，
 * 此时以键内值为准——读路径返回自己查到的旧值会把吊销推迟到 TTL 之后。
 *
 * `NX` 失败后读路径**不再写回**。两种成因都指向「键的现状比本次查库更新」：
 * - 键内脏值（外部写入/旧格式）：换掉它看似能省掉后续回源，但那是一次无 CAS 的
 *   盲写——可能落在并发写路径刚提交的新值上，把吊销推迟一个 TTL；
 * - 键已消失（错过竞争、TTL 到期）：重建等于把「查库那一刻的旧值」重新写回去。
 *
 * 代价是脏值期间每个请求回源一次，直到脏值被写路径或 TTL 清掉。读路径的本职是
 * 判定，不是修复存储：省下的那次回源换来的是「读路径可能覆盖权威写」的窗口。
 */
async function writeIfAbsent(
  redis: Redis,
  userId: number,
  snapshot: AuthSnapshot,
): Promise<AuthSnapshot> {
  try {
    const written = await redis.set(
      keyOf(userId),
      serialize(snapshot),
      "EX",
      AUTH_SNAPSHOT_TTL_SECONDS,
      "NX",
    );
    if (written === "OK") return snapshot;
    const current = await redis.get(keyOf(userId));
    // 键在 NX 与回读之间消失：不写回，本次请求用查库结果（规则 2.2 第 4 步）
    if (current === null) return snapshot;
    // 键仍在：以键内值为准；形态非法时也不能覆盖（理由见上），按未命中返回查库结果
    return parseSnapshot(current) ?? snapshot;
  } catch (err) {
    logFailure(err, userId);
    // 回填失败只影响下一次读取是否命中，鉴权结果本身已由查库得出（规则 2.4）
    metrics.authSnapshot("error");
    return snapshot;
  }
}

/**
 * 读取账号状态；返回 null 表示用户不存在（不写负缓存）。
 *
 * 同一用户的并发未命中在本进程内合并为一次回源：热点用户冷启动时不会因为
 * 一屏并发请求而放大成同等数量的数据库查询。
 */
export async function readAuthSnapshot(userId: number): Promise<AuthSnapshot | null> {
  const startedAt = performance.now();
  try {
    const redis = getRequestPathRedis();
    if (!redis) {
      metrics.authSnapshot("db_fallback");
      return await loadFromDatabase(userId);
    }

    try {
      const cached = await redis.get(keyOf(userId));
      if (cached !== null) {
        const snapshot = parseSnapshot(cached);
        if (snapshot) {
          metrics.authSnapshot("hit");
          return snapshot;
        }
        // 形态不可解析按未命中处理：回源会覆盖它
      }
    } catch (err) {
      logFailure(err, userId);
      metrics.authSnapshot("error");
      return loadFromDatabase(userId);
    }

    metrics.authSnapshot("miss");
    // 回源与回填同属一次单飞：并发未命中只查一次库、只写一次键，
    // 且全体等待者拿到的是同一个「NX 竞争后」的权威值
    return runSingleFlight({
      key: keyOf(userId),
      generate: async () => {
        const loaded = await loadFromDatabase(userId);
        if (!loaded) return null;
        return writeIfAbsent(redis, userId, loaded);
      },
    });
  } finally {
    // 验签耗时覆盖快照命中与回源两条路径：这是每个已登录请求都要付的固定成本
    metrics.authVerify((performance.now() - startedAt) / 1000);
  }
}

/**
 * 写路径失效：把提交后的权威状态写入快照。
 *
 * 写入而非删除：下一个请求直接拿到新状态，不必回源；删除只会把成本推给读路径。
 * 写入失败时退化为删除（让读路径回源），仍失败则依赖 TTL 上界并记录错误与指标
 * （specs/auth-request-verification.md 规则 4.4）。
 *
 * 无 Redis 连接时不记写路径结果：什么都没尝试，下一次读取自会记 `db_fallback`，
 * 在这里补一笔会让读路径的回源比例虚高。
 */
export async function invalidateAuthSnapshot(user: AuthSnapshotSource): Promise<void> {
  const redis = getRequestPathRedis();
  if (!redis) return;
  const key = keyOf(user.id);
  try {
    await redis.set(key, serialize(user), "EX", AUTH_SNAPSHOT_TTL_SECONDS);
    metrics.authSnapshot("invalidated");
    return;
  } catch (err) {
    logFailure(err, user.id);
  }
  try {
    await redis.del(key);
    metrics.authSnapshot("invalidated_fallback");
  } catch (err) {
    logFailure(err, user.id);
    metrics.authSnapshot("invalidate_error");
  }
}
