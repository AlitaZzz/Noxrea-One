/**
 * 媒体处理并发池：ffmpeg 重型 / ffmpeg 轻型 / sharp 三个全局池（specs/media-processing-concurrency.md）。
 * 上限、队列深度、等待时限来自运行期设置（media.*），改库重启生效。
 *
 * 重型池（整段解码 / 重编码）两级准入：先取属主用户的个人名额，再取全局槽位，
 * 释放顺序相反。每人至多 user_max_concurrency 个请求进入全局阶段，全局 FIFO
 * 即按用户轮转——单个用户无法占满全站的重编码能力。
 * 轻型池（单帧、流拷贝）与 sharp 池不按用户限额：单个任务短、等待时限小。
 */

import { getSetting, type SettingKey } from "@server/core/settings";
import {
  BoundedGate,
  GateRejectedError,
  getUserGateCounts,
  waitForUserConcurrency,
  type GateRejectionReason,
} from "@server/core/ratelimit/concurrency";
import { logEvent } from "@server/core/logger/utils";

export type MediaPoolName = "ffmpeg_heavy" | "ffmpeg_light" | "sharp";

/** 过载被拒时所处的准入阶段：user = 个人名额阶段（429），global = 全局槽位阶段（503） */
export type MediaPoolScope = "user" | "global";

/** 各池三项限额对应的设置键 */
const POOL_SETTING_KEYS = {
  ffmpeg_heavy: {
    maxConcurrency: "media.ffmpeg_heavy_max_concurrency",
    maxPending: "media.ffmpeg_heavy_max_pending",
    maxWaitSeconds: "media.ffmpeg_heavy_max_wait_seconds",
  },
  ffmpeg_light: {
    maxConcurrency: "media.ffmpeg_light_max_concurrency",
    maxPending: "media.ffmpeg_light_max_pending",
    maxWaitSeconds: "media.ffmpeg_light_max_wait_seconds",
  },
  sharp: {
    maxConcurrency: "media.sharp_max_concurrency",
    maxPending: "media.sharp_max_pending",
    maxWaitSeconds: "media.sharp_max_wait_seconds",
  },
} as const satisfies Record<MediaPoolName, Record<string, SettingKey>>;

/** 全局阶段过载响应的 Retry-After（秒）：重型任务重、等待容忍度高，轻型与 sharp 是交互式短任务 */
export const MEDIA_POOL_RETRY_AFTER_SECONDS: Record<MediaPoolName, number> = {
  ffmpeg_heavy: 5,
  ffmpeg_light: 1,
  sharp: 1,
};

/** 个人阶段过载（429 media.user_busy）的 Retry-After（秒）：自己的任务结束后即可重试 */
export const MEDIA_USER_BUSY_RETRY_AFTER_SECONDS = 5;

/** 媒体池过载：队列满或排队超时，任务未启动。scope 区分个人限额与全局容量 */
export class MediaPoolBusyError extends Error {
  constructor(
    public readonly pool: MediaPoolName,
    public readonly scope: MediaPoolScope,
    public readonly reason: GateRejectionReason,
  ) {
    super(`Media pool "${pool}" busy at ${scope} stage (${reason})`);
    this.name = "MediaPoolBusyError";
  }
}

const pools = new Map<MediaPoolName, BoundedGate>();

/** 槽位数在首次使用时按设置快照固定；设置只在重启后变化 */
function getPoolGate(pool: MediaPoolName): BoundedGate {
  let gate = pools.get(pool);
  if (!gate) {
    gate = new BoundedGate(`media.${pool}`, getSetting(POOL_SETTING_KEYS[pool].maxConcurrency));
    pools.set(pool, gate);
  }
  return gate;
}

function wrapRejection(pool: MediaPoolName, scope: MediaPoolScope, err: unknown): never {
  if (err instanceof GateRejectedError) {
    logEvent("media", {
      stage: "media_pool_rejected",
      pool,
      scope,
      reason: err.reason,
      active: getPoolGate(pool).activeCount,
      pending: getPoolGate(pool).pendingCount,
      max_concurrency: getPoolGate(pool).capacity,
      max_pending: getSetting(POOL_SETTING_KEYS[pool].maxPending),
      max_wait_seconds: getSetting(POOL_SETTING_KEYS[pool].maxWaitSeconds),
    });
    throw new MediaPoolBusyError(pool, scope, err.reason);
  }
  throw err;
}

/** 记录等待超过 1s 的获取，供压测调参 */
function logSlowWait(pool: MediaPoolName, waitMs: number): void {
  if (waitMs > 1000) {
    const gate = getPoolGate(pool);
    logEvent("media", {
      stage: "media_pool_wait",
      pool,
      waitMs,
      active: gate.activeCount,
      pending: gate.pendingCount,
    });
  }
}

async function acquireGlobalSlot(
  pool: MediaPoolName,
  signal?: AbortSignal,
  maxWaitMs?: number,
): Promise<() => void> {
  const startedAt = Date.now();
  try {
    const release = await getPoolGate(pool).acquire({ signal, maxPending: getSetting(POOL_SETTING_KEYS[pool].maxPending), maxWaitMs });
    logSlowWait(pool, Date.now() - startedAt);
    return release;
  } catch (err) {
    wrapRejection(pool, "global", err);
  }
}

/**
 * 获取轻型池 / sharp 池槽位；返回的释放函数幂等，必须在处理真正结束后调用。
 * 队列满 / 排队超时抛 MediaPoolBusyError(scope="global")（不启动任何处理）；
 * 排队期间 AbortSignal 触发抛 AbortError。
 */
export async function acquireMediaSlot(pool: "ffmpeg_light" | "sharp", signal?: AbortSignal): Promise<() => void> {
  return acquireGlobalSlot(pool, signal, getSetting(POOL_SETTING_KEYS[pool].maxWaitSeconds) * 1000);
}

/**
 * 获取重型池槽位（两级准入）：先取属主用户的个人名额，再取全局槽位。
 * 等待时限从调用开始计，个人排队与全局排队合计。返回的释放函数幂等，
 * 先放全局槽位、再放个人名额，必须在子进程真正结束后调用。
 * 个人阶段被拒 → MediaPoolBusyError(scope="user")，调用方回 429 media.user_busy；
 * 全局阶段被拒 → scope="global"，回 503 media.busy。
 * 排队期间 AbortSignal 触发抛 AbortError，不占名额、不占槽位。
 */
export async function acquireHeavySlot(owner: number, signal?: AbortSignal): Promise<() => void> {
  const budgetMs = getSetting("media.ffmpeg_heavy_max_wait_seconds") * 1000;
  const userMaxConcurrent = getSetting("media.ffmpeg_heavy_user_max_concurrency");
  const userMaxPending = getSetting("media.ffmpeg_heavy_user_max_pending");

  const startedAt = Date.now();
  let releasePersonal: () => void;
  try {
    releasePersonal = await waitForUserConcurrency(
      "media.ffmpeg_heavy.user",
      owner,
      userMaxConcurrent,
      signal,
      userMaxPending,
      budgetMs,
    );
  } catch (err) {
    if (err instanceof GateRejectedError) {
      logEvent("media", {
        stage: "media_pool_rejected",
        pool: "ffmpeg_heavy",
        scope: "user",
        userId: owner,
        reason: err.reason,
        ...getUserGateCounts("media.ffmpeg_heavy.user", owner),
        max_concurrency: userMaxConcurrent,
        max_pending: userMaxPending,
        max_wait_seconds: budgetMs / 1000,
      });
      throw new MediaPoolBusyError("ffmpeg_heavy", "user", err.reason);
    }
    throw err;
  }

  try {
    const releaseGlobal = await acquireGlobalSlot(
      "ffmpeg_heavy",
      signal,
      Math.max(0, budgetMs - (Date.now() - startedAt)),
    );
    // 先放全局槽位、再放个人名额；两层释放各自幂等
    return () => {
      releaseGlobal();
      releasePersonal();
    };
  } catch (err) {
    releasePersonal();
    wrapRejection("ffmpeg_heavy", "global", err);
  }
}
