/**
 * 分布式限流（Redis 滑动窗口）。
 *
 * 计数存放在 Redis，多副本共享同一配额；限流额度等业务策略来自 system_settings。
 * Redis 是请求路径上的旁路依赖：启动期建连失败直接让启动失败（与任务队列同口径），
 * 运行期命令失败则 fail-open 放行并记录错误——可用性优先，避免 Redis 抖动放大为
 * 全站登录 / 生成 / 媒体编辑不可用。命令失败与连接错误日志均按固定间隔去重。
 */
import { getConfig } from "@server/core/config";
import { logger } from "@server/core/logger";
import { getSetting } from "@server/core/settings";

import { createFailureLogThrottle } from "./log-throttle";
import { RedisRateLimitStore } from "./redis-store";
import type { RateLimitQuota, RateLimitResult, RateLimitStore } from "./types";

export type { RateLimitQuota, RateLimitResult, RateLimitStore } from "./types";

/**
 * 策略表是「业务入口 → 设置键」的唯一来源；策略名同时作为 Redis 键前缀
 * （login / register / generate / media-edit），避免名字与前缀两处维护、漂移。
 * 四个业务入口只负责限定身份类型（IP / userId）。
 */
const RATE_LIMIT_POLICIES = {
  login: {
    maxRequestsKey: "rate_limit.login_ip_max_requests",
    windowSecondsKey: "rate_limit.login_window_seconds",
  },
  register: {
    maxRequestsKey: "rate_limit.register_ip_max_requests",
    windowSecondsKey: "rate_limit.register_window_seconds",
  },
  generate: {
    maxRequestsKey: "rate_limit.generate_user_max_requests",
    windowSecondsKey: "rate_limit.generate_window_seconds",
  },
  "media-edit": {
    maxRequestsKey: "rate_limit.media_edit_user_max_requests",
    windowSecondsKey: "rate_limit.media_edit_window_seconds",
  },
} as const;

type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

let store: RateLimitStore | null = null;
/** 建连中的单飞 Promise：并发初始化共享同一次连接，避免重复建连后泄漏其一。 */
let pendingInit: Promise<RateLimitStore> | null = null;
const shouldLogFailure = createFailureLogThrottle();

async function checkPolicy(
  policyName: RateLimitPolicyName,
  identity: string | number,
): Promise<RateLimitResult> {
  // 未初始化属于启动流程不变量，必须抛出错误（async 入口会转成 rejection），
  // 不能落入 fail-open——否则忘记 bootstrap 时限流会静默失效。
  const activeStore = requireStore();
  const policy = RATE_LIMIT_POLICIES[policyName];
  const quota: RateLimitQuota = {
    maxRequests: getSetting(policy.maxRequestsKey),
    windowSeconds: getSetting(policy.windowSecondsKey),
  };
  try {
    return await activeStore.check(`${policyName}:${identity}`, quota);
  } catch (err) {
    if (shouldLogFailure()) {
      logger.error({ err }, "rate limit store unavailable; failing open");
    }
    return { allowed: true };
  }
}

function requireStore(): RateLimitStore {
  if (!store) {
    throw new Error("Rate limit is not initialized; call bootstrap() first");
  }
  return store;
}

/** 幂等初始化；并发调用共享同一次建连。 */
export async function initRateLimit(): Promise<void> {
  if (store) return;
  pendingInit ??= RedisRateLimitStore.connect(getConfig().REDIS_URL);
  try {
    store = await pendingInit;
  } finally {
    pendingInit = null;
  }
}

/** 停机收尾：断开限流连接；后续请求不应再发生（HTTP 已停止接收）。 */
export async function closeRateLimit(): Promise<void> {
  const current = store;
  store = null;
  if (current) await current.close();
}

// 具名入口把身份类型固定在调用边界（登录 / 注册为 IP，生成 / 媒体编辑为 userId），
// 避免路由直接传策略名时把用户 id 当 IP 使用；策略名与设置键只在策略表维护。
// 显式声明 async：Promise 契约必须覆盖「未初始化」这条失败路径，
// 让调用方用 try/catch 或 .catch 都能捕获，而不是同步抛出穿透 Promise 链。
export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  return checkPolicy("login", ip);
}

export async function checkRegisterRateLimit(ip: string): Promise<RateLimitResult> {
  return checkPolicy("register", ip);
}

export async function checkGenerateRateLimit(userId: number): Promise<RateLimitResult> {
  return checkPolicy("generate", userId);
}

export async function checkMediaEditRateLimit(userId: number): Promise<RateLimitResult> {
  return checkPolicy("media-edit", userId);
}
