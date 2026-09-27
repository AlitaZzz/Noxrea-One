/**
 * JSON 文本列序列化辅助。
 * 数据库为 SQLite，JSON 以 TEXT 存储，提供对象与 JSON 字符串的相互转换。
 */
import { logger } from "@server/core/logger";

/** 将对象/数组转为存储字符串 */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

/** 从存储字符串解析 JSON，失败返回 fallback（降级语义有意保留，但坏数据必须留下痕迹） */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn(
      { err, raw: String(raw).slice(0, 200) },
      "json column parse failed, degraded to fallback",
    );
    return fallback;
  }
}

/** 从存储字符串解析 JSON 数组 */
export function parseJsonArray(raw: unknown): string[] {
  return parseJson<string[]>(raw, []);
}

/** 从存储字符串解析对象数组 */
export function parseJsonObjectArray<T>(raw: unknown): T[] {
  return parseJson<T[]>(raw, []);
}

/** 从存储字符串解析 JSON 对象 */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(raw, {});
}
