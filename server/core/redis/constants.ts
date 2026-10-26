/** Redis 故障日志最小间隔：命令失败与连接错误共用，避免故障期刷屏。 */
export const REDIS_FAILURE_LOG_INTERVAL_MS = 10_000;
