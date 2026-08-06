/**
 * JSON 文本列序列化辅助。
 * 在 SQLite 以 TEXT 存储 JSON 的场景下，提供对象与 JSON 字符串的相互转换。
 */

import { getConfig } from "@server/core/config";

/** 判断当前是否为 SQLite provider（TEXT 存储 JSON） */
function isSqlite(): boolean {
  const url = getConfig().DATABASE_URL;
  return url.startsWith("file:");
}

/** 将对象/数组转为存储字符串（SQLite 下为 JSON.stringify，PG 下直通） */
export function stringifyJson(value: unknown): string {
  if (isSqlite()) {
    return JSON.stringify(value);
  }
  // PG 下 Prisma Json 类型直接返回对象 — 需要确保 value 已经是 string 或可序列化
  if (typeof value === "string") return value;
  // 如果 value 是对象但当前不是 SQLite，则仍然序列化（兼容 PG 过渡期）
  return JSON.stringify(value);
}

/** 从存储字符串解析 JSON，失败返回 fallback */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (isSqlite()) {
    if (typeof raw !== "string") return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  // PG 下 Prisma Json 类型已自动解析
  return raw as T;
}

/** 从存储字符串解析 JSON 数组 */
export function parseJsonArray(raw: unknown): string[] {
  return parseJson<string[]>(raw, []);
}

/** 从存储字符串解析 JSON 对象 */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(raw, {});
}
