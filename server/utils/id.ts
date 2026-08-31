/**
 * 短 ID 生成与校验。
 *
 * 格式：8 位 base36 毫秒时间戳 + 6 位 base36 随机串，共 14 字符。
 * 示例：m9k3x7qa2p1c
 *
 * 设计取舍：
 *  - 时间前缀保证 SQLite B-tree 顺序追加，避免随机写导致页分裂
 *  - 随机段提供约 31 bits 不可预测性，防止 ID 被枚举
 *  - 全程字符串，不触碰 JS 的 2^53 整数精度红线（对比雪花 ID 的 BigInt 陷阱）
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 时间戳段长度（base36，8 位覆盖到 2059 年） */
const TIMESTAMP_LENGTH = 8;
/** 随机段长度（base36，6 位 ≈ 31 bits） */
const RANDOM_LENGTH = 6;

/** 生成一个 14 字符的时间有序短 ID */
export function newId(): string {
  const timestamp = Date.now().toString(36).padStart(TIMESTAMP_LENGTH, "0");

  // 逐字节取模映射到 base36。256 % 36 != 0 存在极轻微偏差（前 4 个字符
  // 出现概率高约 1/64），对不可枚举性的影响可忽略，换来零依赖实现。
  const bytes = randomBytes(RANDOM_LENGTH);
  let random = "";
  for (const b of bytes) random += ALPHABET[b % 36];

  return timestamp + random;
}

/** 校验是否为合法的短 ID（14 位小写 base36） */
export function isValidId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{14}$/.test(value);
}
