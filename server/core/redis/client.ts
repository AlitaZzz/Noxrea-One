/**
 * 请求路径 Redis 连接（限流与鉴权快照共用一条）。
 *
 * 连接策略：两者都是请求路径上的旁路依赖，Redis 抖动时必须快速失败而不是排队，
 * 因此关闭 offline queue、设置命令超时；命令失败由各自上层决定兜底语义
 * （限流 fail-open、鉴权快照回源数据库），连接错误只记日志并按固定间隔去重。
 *
 * 启动期建连失败直接让启动失败（与任务队列同口径）：带着不可用的旁路依赖
 * 进入服务态，只会在第一个请求才暴露问题。
 *
 * BullMQ 的连接**不**走这里：它要求 `maxRetriesPerRequest: null` 与阻塞命令的
 * 专用连接语义（见 services/worker/queue.ts），与请求路径策略冲突。
 */
import IORedis, { type Redis } from "ioredis";

import { getConfig } from "@server/core/config";
import { logger } from "@server/core/logger";

import { createFailureLogThrottle } from "./log-throttle";

/** 单条命令超时：请求路径上的 Redis 慢响应必须快速失败。 */
const COMMAND_TIMEOUT_MS = 2_000;
/** 启动期建连超时：不可达即启动失败，不在后台无限重连。 */
const CONNECT_TIMEOUT_MS = 3_000;
/** 断连时在途命令最多重发一次（ioredis 在重连后按该值冲刷命令队列）。 */
const MAX_RETRIES_PER_REQUEST = 1;

let client: Redis | null = null;
/** 建连中的单飞 Promise：并发初始化共享同一次连接，避免重复建连后泄漏其一。 */
let pendingInit: Promise<Redis> | null = null;

/**
 * 已建立的请求路径连接；未初始化（如单测未跑 bootstrap）时返回 null。
 * 鉴权快照据此回源数据库，而不是因为基础设施未就绪就拒绝一切请求。
 */
export function getRequestPathRedis(): Redis | null {
  return client;
}

/**
 * 必须已初始化的连接。限流使用它：未初始化属于启动流程不变量，
 * 静默跳过只会让限流在无告警的情况下失效。
 */
export function requireRequestPathRedis(): Redis {
  if (!client) {
    throw new Error("Request-path Redis is not initialized; call bootstrap() first");
  }
  return client;
}

/** 幂等初始化；并发调用共享同一次建连。 */
export async function initRequestPathRedis(): Promise<void> {
  if (client) return;
  pendingInit ??= connect(getConfig().REDIS_URL);
  try {
    client = await pendingInit;
  } finally {
    pendingInit = null;
  }
}

/** 停机收尾：断开请求路径连接；后续请求不应再发生（HTTP 已停止接收）。 */
export async function closeRequestPathRedis(): Promise<void> {
  const current = client;
  client = null;
  if (!current) return;
  try {
    await current.quit();
  } catch {
    // 连接已断开时 quit() 会抛错；此时直接断开即可，不把停机失败抛给调用方。
    current.disconnect();
  }
}

async function connect(url: string): Promise<Redis> {
  const conn = new IORedis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    commandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });

  const shouldLogConnectionError = createFailureLogThrottle();
  conn.on("error", (err) => {
    // 连接错误只记日志不抛：运行期瞬断由各上层兜底，未处理的 error 事件会让进程崩溃。
    // ioredis 会持续重连并按退避反复触发该事件，日志同样按固定间隔去重。
    if (!shouldLogConnectionError()) return;
    logger.warn({ err }, "request-path redis connection error");
  });

  try {
    await conn.connect();
    await conn.ping();
  } catch (err) {
    // 建连 / 探测失败即启动失败：必须主动断开，否则客户端会在后台持续重连并占用句柄。
    conn.disconnect();
    throw err;
  }
  return conn;
}
