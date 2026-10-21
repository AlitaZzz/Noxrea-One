/** 限流键命名空间：与 BullMQ 的 noxrea:queue: 隔离，共用同一 Redis 实例。 */
export const RATE_LIMIT_KEY_PREFIX = "noxrea:ratelimit:";

/** 故障日志最小间隔：命令失败与连接错误共用，避免 Redis 故障期刷屏。 */
export const RATE_LIMIT_ERROR_LOG_INTERVAL_MS = 10_000;
