import { REDIS_FAILURE_LOG_INTERVAL_MS } from "./constants";

/**
 * Redis 故障日志节流：命令失败与连接错误共用同一间隔定义。
 * 返回「本次是否应当记录」的判定，同一实例在间隔内只放行一次；
 * 故障期每个请求、每次重连都会失败，日志必须去重，但又不能遮蔽持续故障。
 *
 * 限流与鉴权快照共用本模块：两处都要求「Redis 抖动不放大为日志洪峰」。
 */
export function createFailureLogThrottle(): () => boolean {
  // 初值不能是 0：时钟起点（如测试把系统时间设为 0）会被误判为「刚记录过」
  let lastAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = Date.now();
    if (now - lastAt < REDIS_FAILURE_LOG_INTERVAL_MS) return false;
    lastAt = now;
    return true;
  };
}
