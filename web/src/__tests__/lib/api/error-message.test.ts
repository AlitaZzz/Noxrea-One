/**
 * resolveApiError 单元测试：api() 失败抛 ApiError 前都要能拿到非空文案。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/config", () => ({
  default: {
    t: (k: string) => k,
    exists: () => false,
  },
}));

import { resolveApiError } from "@/lib/api/error-message";

describe("resolveApiError", () => {
  it("响应缺失（null）时不抛异常且回退到兜底文案", () => {
    expect(resolveApiError(null, undefined, "project.rename_failed")).toBe("error.project.rename_failed");
  });

  it("错误码未登记翻译时回退到兜底文案，不把裸错误码展示给用户", () => {
    expect(resolveApiError({ error: "some_unregistered_code" }, 500, "project.rename_failed")).toBe(
      "error.project.rename_failed"
    );
  });

  it("带 HTTP 状态码时仍返回非空文案", () => {
    expect(resolveApiError(null, 500, "project.rename_failed")).toBeTruthy();
  });

  it("fallbackKey 缺省时退到 error.unknown", () => {
    expect(resolveApiError(null)).toBe("error.unknown");
  });

  it("错误体带 ctx 插值参数时不抛异常", () => {
    expect(() => resolveApiError({ error: "x", ctx: { status: 502 } }, undefined, "models.fetch_failed")).not.toThrow();
  });
});
