/**
 * PostgreSQL 连接池配置。
 * DATABASE_URL 与连接池上限同属数据库层引导配置，因此这里直接读取 env，
 * 避免数据库客户端依赖完整业务配置（配置缺失时仍能给出明确的 DATABASE_POOL_MAX 错误）。
 */
import { parseIntegerText } from "@server/core/numeric-text";

/** node-postgres 的默认连接池上限；显式配置时以 DATABASE_POOL_MAX 为准。 */
export const DEFAULT_DATABASE_POOL_MAX = 10;

const INVALID_DATABASE_POOL_MAX =
  "DATABASE_POOL_MAX must be a positive integer written as plain digits within the safe integer range.";

/**
 * 每个进程的 PostgreSQL 连接池上限。
 * 多副本规划：副本数 × 每进程 pool_max + 迁移/运维余量 ≤ PostgreSQL max_connections。
 */
export function databasePoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DATABASE_POOL_MAX;
  // 纯数字文本 + 安全整数：拒绝 "-1"、"1.5"、"1e2"、" 10 " 等 Number() 会宽松接受的写法
  const parsed = parseIntegerText(raw);
  if (!parsed.ok || parsed.value < 1) {
    throw new Error(INVALID_DATABASE_POOL_MAX);
  }
  return parsed.value;
}
