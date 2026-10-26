/** 限流键命名空间：与 BullMQ 的 noxrea:queue: 隔离，共用同一 Redis 实例。 */
export const RATE_LIMIT_KEY_PREFIX = "noxrea:ratelimit:";
