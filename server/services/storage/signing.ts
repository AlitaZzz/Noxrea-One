/**
 * 预签名参数常量与派生（specs/storage-signed-direct-delivery.md 规则 4）。
 *
 * 不放 system_settings：TTL 与窗口是签名/缓存协议的不变量，配错会直接破坏
 * 签名或缓存语义；代码变更是这类变更的正确仪式。唯一例外是将来出现明确的
 * 合规需求时，把 TTL 单独提升为设置项，窗口保持常量。
 */

/** SigV4 预签名 URL 有效期硬上限（7 天，@smithy/signature-v4 的 MAX_PRESIGNED_TTL） */
export const MAX_PRESIGNED_URL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 浏览器描述 URL 的最长寿命（秒）：URL 泄漏后的可用时长上限。
 *
 * 签名时刻对齐到窗口起点、`expiresIn` 只取 TTL，因此实际剩余寿命落在
 * `[TTL - WINDOW, TTL]`（3h–4h）；旧协议 `expiresIn = TTL + WINDOW` 会把
 * 寿命抬到 TTL 之上，已废止。
 */
export const PRESIGNED_READ_TTL_SECONDS = 4 * 60 * 60;

/** 签名窗口（秒）= TTL/4：窗口内签出的 URL 逐字节一致，窗口长度即 URL 稳定期 */
export const PRESIGNED_READ_WINDOW_SECONDS = PRESIGNED_READ_TTL_SECONDS / 4;

/**
 * 能力凭据（上游引用、媒体工具输入）的寿命（秒）。
 *
 * 与浏览器读路径**分离**：上游只要是「签发即用」，收紧或放宽浏览器方案
 * 都不应牵连它。这也是 S3 后端的缺省预签名 TTL（`signedUrlTtlSeconds`）。
 */
export const CAPABILITY_URL_TTL_SECONDS = 60 * 60;

/** 刷新建议点：寿命的 80%（客户端在此之后重新描述，见规则 4.7） */
const REFRESH_AT_RATIO = 0.8;

/**
 * 预签名参数守卫（唯一入口）：ttl 与窗口均为正整数秒，窗口不得超过 TTL，
 * 且 TTL 不超过 SigV4 上限。
 */
export function assertPresignedParameters(ttlSeconds: number, windowSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`Presigned TTL must be a positive integer number of seconds: ${ttlSeconds}`);
  }
  // 对齐算法以窗口为除数：`0` 会签出 `NaN` 日期、负值会把签名时刻推到未来。
  // 规则 4.6 明确禁止「不对齐」（`windowSeconds = 0`）。
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error(
      `Presigned window must be a positive integer number of seconds: ${windowSeconds}`,
    );
  }
  // 窗口长于寿命意味着窗口末段签出的 URL 已经过期（到期时刻 = 窗口起点 + TTL < 当前时刻）
  if (windowSeconds > ttlSeconds) {
    throw new Error(
      `Presigned window must not exceed the TTL: ${windowSeconds} > ${ttlSeconds}`,
    );
  }
  if (ttlSeconds > MAX_PRESIGNED_URL_SECONDS) {
    throw new Error(
      `Presigned read TTL exceeds the SigV4 limit of ${MAX_PRESIGNED_URL_SECONDS}s: ${ttlSeconds}`,
    );
  }
}

// 浏览器读路径的两个常量必须保持 TTL = 4 × 窗口：窗口语义单一来源，改一个漏改另一个
// 会在模块加载时立刻失败，而不是让 URL 稳定期悄悄偏离设计
assertPresignedParameters(PRESIGNED_READ_TTL_SECONDS, PRESIGNED_READ_WINDOW_SECONDS);
if (PRESIGNED_READ_WINDOW_SECONDS * 4 !== PRESIGNED_READ_TTL_SECONDS) {
  throw new Error(
    `Presigned read window must be TTL/4: ${PRESIGNED_READ_WINDOW_SECONDS} * 4 `
    + `!== ${PRESIGNED_READ_TTL_SECONDS}`,
  );
}

/**
 * 对齐到窗口边界的签名时刻（毫秒）。唯一调用方是 {@link presignedWindow}：
 * 参数守卫在那一处执行，本函数只做算术——不再自带一份守卫，否则同一组参数
 * 会在调用链上被校验两次，且两份守卫迟早会对「什么算合法窗口」给出不同答案。
 */
function alignedSigningTimeMs(windowSeconds: number, nowMs: number): number {
  return Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
}

/** 一次签名的时间窗口（Unix 秒）：客户端据此决定何时刷新 */
interface PresignedWindow {
  /** 签名时刻（窗口起点） */
  issuedAt: number;
  /** URL 失效时刻 */
  expiresAt: number;
  /** 建议重新描述的时刻（寿命的 80%） */
  refreshAt: number;
}

/**
 * 按对齐窗口计算一次签名的三个时刻。签名参数守卫的唯一入口：
 * `presignGet` 的签名时刻也取自这里（`issuedAt`），两边不可能用上不同的窗口。
 *
 * 必须与 `presignGet` 用同一组参数：若这里算出的失效时刻早于真实 URL，
 * 客户端会提前刷新（安全侧偏差）；晚于真实 URL，客户端会拿着必然 403 的地址。
 */
export function presignedWindow(
  ttlSeconds: number,
  windowSeconds: number,
  nowMs = Date.now(),
): PresignedWindow {
  assertPresignedParameters(ttlSeconds, windowSeconds);
  const issuedAt = Math.floor(alignedSigningTimeMs(windowSeconds, nowMs) / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const refreshAt = issuedAt + Math.floor((expiresAt - issuedAt) * REFRESH_AT_RATIO);
  return { issuedAt, expiresAt, refreshAt };
}

/**
 * 预签名响应对浏览器下发的缓存头（规则 4.3）：寿命取**窗口寿命**
 * （`expiresAt - issuedAt`，恒等于 TTL），不使用 `public`。
 *
 * 不取 `expiresAt - now`：该头会进入预签名 URL 的查询串（`response-cache-control`），
 * 逐秒变化的寿命会让同窗口内签出的 URL 不再逐字节一致，窗口机制（规则 4.4）
 * 与以 URL 为键的缓存随之全部失效。客户端在 `refreshAt`（寿命 80%）之后就不再
 * 使用该 URL，因此按窗口寿命下发的缓存寿命不会被用来持有失效地址。
 */
export function presignedCacheControl(window: PresignedWindow): string {
  return `private, max-age=${Math.max(0, window.expiresAt - window.issuedAt)}, immutable`;
}
