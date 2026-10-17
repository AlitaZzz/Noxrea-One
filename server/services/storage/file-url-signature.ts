/**
 * 应用层签名 URL（specs/storage-s3-backend.md 业务规则 6/12 双凭据模型）。
 *
 * files 路由的凭据路径之一：`?expires=<unix秒>&signature=<hex>`。
 * 供上游 AI 等无会话消费方在 local 后端下直连拉取媒体（S3 后端走预签名
 * URL，不经此模块）；与浏览器会话凭据解耦，两类凭据互不影响。
 *
 * 密钥由 JWT 密钥域分离派生（HMAC("noxrea:file-url:v1")），签名覆盖
 * key 与过期时间；URL 不入库不持久化，每次签发即时计算——重试即重签。
 * 过期与签名不符（时序安全比较）一律拒绝。
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getConfig } from "@server/core/config";

let derivedKey: Buffer | null = null;

/** 签名密钥：从 JWT 密钥派生专用子钥，避免签名体系与令牌体系直接共用同一密文 */
function signingKey(): Buffer {
  if (!derivedKey) {
    derivedKey = createHmac("sha256", getConfig().JWT_SECRET_KEY).update("noxrea:file-url:v1").digest();
  }
  return derivedKey;
}

function sign(key: string, expires: number): string {
  return createHmac("sha256", signingKey()).update(`${key}:${expires}`).digest("hex");
}

/**
 * 为存储 key 签发签名参数（expires 为 unix 秒）。
 * 调用方自行拼进 URL query（与 buildManagedFileUrl 产物配合使用）。
 */
export function signFileUrlParams(key: string, ttlSeconds: number): { expires: number; signature: string } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { expires, signature: sign(key, expires) };
}

/**
 * 校验签名参数：签名与 key、expires 绑定；过期或签名不符返回 false。
 * expires 非规范十进制整数视为无效（NaN/负数/浮点都进不了过期比较）。
 */
export function verifyFileUrlSignature(
  key: string,
  expires: string | null | undefined,
  signature: string | null | undefined,
): boolean {
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  const exp = Number(expires);
  if (exp * 1000 <= Date.now()) return false;
  const expected = sign(key, exp);
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
