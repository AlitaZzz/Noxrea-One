import { RATE_LIMIT_ERROR_LOG_INTERVAL_MS } from "./constants";

/**
 * 限流故障日志节流：命令失败与连接错误共用同一间隔定义。
 * 返回「本次是否应当记录」的判定，同一实例在间隔内只放行一次；
 * 限流故障期每个请求、每次重连都会失败，日志必须去重，但又不能遮蔽持续故障。
 */
export function createFailureLogThrottle(): () => boolean {
  // 初值不能是 0：时钟起点（如测试把系统时间设为 0）会被误判为「刚记录过」
  let lastAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = Date.now();
    if (now - lastAt < RATE_LIMIT_ERROR_LOG_INTERVAL_MS) return false;
    lastAt = now;
    return true;
  };
}
