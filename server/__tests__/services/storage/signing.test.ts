/**
 * 预签名常量、参数守卫与窗口派生（specs/storage-signed-direct-delivery.md 规则 4）。
 */
import {
  assertPresignedParameters,
  CAPABILITY_URL_TTL_SECONDS,
  MAX_PRESIGNED_URL_SECONDS,
  PRESIGNED_READ_TTL_SECONDS,
  PRESIGNED_READ_WINDOW_SECONDS,
  presignedCacheControl,
  presignedWindow,
} from "@server/services/storage/signing";
import { describe, expect, it } from "vitest";

describe("签名常量（规则 4.1）", () => {
  it("浏览器读路径 4h 寿命 / 1h 窗口，且窗口恒为 TTL/4", () => {
    expect(PRESIGNED_READ_TTL_SECONDS).toBe(4 * 60 * 60);
    expect(PRESIGNED_READ_WINDOW_SECONDS * 4).toBe(PRESIGNED_READ_TTL_SECONDS);
  });

  it("能力凭据寿命与浏览器读路径分离，保持 1h", () => {
    expect(CAPABILITY_URL_TTL_SECONDS).toBe(60 * 60);
    // 缺省窗口 ceil(ttl / 4) = 900s，与修订前的对齐窗口一致（规则 4.6）
    expect(Math.ceil(CAPABILITY_URL_TTL_SECONDS / 4)).toBe(900);
  });

  it("TTL 不超过 SigV4 上限", () => {
    expect(PRESIGNED_READ_TTL_SECONDS).toBeLessThanOrEqual(MAX_PRESIGNED_URL_SECONDS);
    expect(() =>
      assertPresignedParameters(PRESIGNED_READ_TTL_SECONDS, PRESIGNED_READ_WINDOW_SECONDS)).not.toThrow();
  });
});

describe("预签名参数守卫（规则 4.6：缺省不得改为「不对齐」）", () => {
  it("窗口 0 / 负值 / 非整数与非法 TTL 一律拒绝", () => {
    expect(() => assertPresignedParameters(3600, 0)).toThrow(/window/);
    expect(() => assertPresignedParameters(3600, -60)).toThrow(/window/);
    expect(() => assertPresignedParameters(3600, 60.5)).toThrow(/window/);
    expect(() => assertPresignedParameters(0, 60)).toThrow(/TTL/);
    expect(() => assertPresignedParameters(60.5, 60)).toThrow(/TTL/);
  });

  it("窗口不得长于寿命（窗口末段签出的 URL 会立即过期）", () => {
    expect(() => assertPresignedParameters(3600, 3601)).toThrow(/window/);
    expect(() => assertPresignedParameters(3600, 3600)).not.toThrow();
  });

  it("恰好等于 SigV4 上限时通过，超过 1 秒即抛错", () => {
    expect(() => assertPresignedParameters(MAX_PRESIGNED_URL_SECONDS, 60)).not.toThrow();
    expect(() => assertPresignedParameters(MAX_PRESIGNED_URL_SECONDS + 1, 60)).toThrow(/SigV4/);
  });

  it("签名时刻的唯一入口自带守卫：除零不会产出 NaN 签名时刻", () => {
    // presignGet 的签名时刻取自 presignedWindow(...).issuedAt，窗口在这里就被拒绝，
    // 不存在绕过守卫直接算对齐时刻的调用方
    expect(() => presignedWindow(3600, 0)).toThrow(/window/);
  });
});

describe("窗口对齐与三个时刻（规则 4.2 / 4.7）", () => {
  it("签名时刻对齐 epoch 绝对窗口边界", () => {
    expect(presignedWindow(3600, 60, 1_234_567_890_123).issuedAt * 1000).toBe(1_234_567_860_000);
    expect(presignedWindow(3600, 60, 1_234_560_000_000).issuedAt * 1000).toBe(1_234_560_000_000);
  });

  it("expiresAt = 窗口起点 + TTL（签名 expiresIn 只取 TTL，不再叠加窗口）", () => {
    const nowMs = 1_234_567_890_123;
    const window = presignedWindow(3600, 900, nowMs);
    expect(window.issuedAt).toBe(Math.floor(nowMs / 900_000) * 900);
    expect(window.expiresAt).toBe(window.issuedAt + 3600);
  });

  it("同一窗口内签出的 URL 三个时刻一致（缓存键稳定的前提）", () => {
    const windowStart = 1_234_560_000_000;
    const first = presignedWindow(3600, 60, windowStart + 1);
    expect(presignedWindow(3600, 60, windowStart + 59_999)).toEqual(first);
    expect(presignedWindow(3600, 60, windowStart + 60_000).issuedAt).toBe(first.issuedAt + 60);
  });

  it("refreshAt 为寿命的 80%，且严格早于 expiresAt", () => {
    const window = presignedWindow(PRESIGNED_READ_TTL_SECONDS, PRESIGNED_READ_WINDOW_SECONDS, 0);
    expect(window.refreshAt).toBe(window.issuedAt + Math.floor(PRESIGNED_READ_TTL_SECONDS * 0.8));
    expect(window.refreshAt).toBeLessThan(window.expiresAt);
  });
});

describe("预签名缓存头（规则 4.3）", () => {
  it("寿命取窗口寿命（恒等于 TTL），private + immutable", () => {
    const window = presignedWindow(PRESIGNED_READ_TTL_SECONDS, PRESIGNED_READ_WINDOW_SECONDS, 0);
    expect(presignedCacheControl(window)).toBe(`private, max-age=${PRESIGNED_READ_TTL_SECONDS}, immutable`);
  });

  it("同窗口内不随时间变化：该头进入 URL 查询串，逐秒变化会让 URL 不再逐字节一致", () => {
    const windowStart = 1_704_067_200_000;
    const head = presignedWindow(3600, 900, windowStart);
    const tail = presignedWindow(3600, 900, windowStart + 899_999);
    expect(presignedCacheControl(tail)).toBe(presignedCacheControl(head));
  });
});
