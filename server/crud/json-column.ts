/**
 * JSON 文本列序列化辅助。
 * 数据库为 PostgreSQL，JSON 以 TEXT 存储，提供对象与 JSON 字符串的相互转换。
 */
import { isRecord } from "@noxrea/shared/object";

import { logger } from "@server/core/logger";

/** 将对象/数组转为存储字符串 */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

type ParseResult = { ok: true; value: unknown } | { ok: false };

/**
 * 从存储字符串解析 JSON。
 * 解析失败时降级（降级语义有意保留，但坏数据必须留下痕迹）。
 */
function parseJson(raw: unknown): ParseResult {
  if (typeof raw !== "string") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    logger.warn(
      { err, raw: String(raw).slice(0, 200) },
      "json column parse failed, degraded to fallback",
    );
    return { ok: false };
  }
}

/** 解析数组列；顶层不是数组时按坏数据降级为空数组。 */
function parseArray<T>(raw: unknown): T[] {
  const result = parseJson(raw);
  if (!result.ok) return [];
  if (!Array.isArray(result.value)) {
    logger.warn(
      { raw: String(raw).slice(0, 200), expected: "array" },
      "json column shape mismatch, degraded to fallback",
    );
    return [];
  }
  return result.value as T[];
}

/** 从存储字符串解析 JSON 数组 */
export function parseJsonArray(raw: unknown): string[] {
  return parseArray<string>(raw);
}

/** 从存储字符串解析对象数组 */
export function parseJsonObjectArray<T>(raw: unknown): T[] {
  return parseArray<T>(raw);
}

/** 从存储字符串解析 JSON 对象；非对象（含 null / 数组 / 标量）按坏数据降级为空对象。 */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  const result = parseJson(raw);
  if (!result.ok) return {};
  if (!isRecord(result.value)) {
    logger.warn(
      { raw: String(raw).slice(0, 200), expected: "object" },
      "json column shape mismatch, degraded to fallback",
    );
    return {};
  }
  return result.value;
}
