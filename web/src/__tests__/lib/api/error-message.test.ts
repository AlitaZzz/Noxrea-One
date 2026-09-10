/**
 * resolveResultError 单元测试：api() 三种失败形态都要能拿到非空文案。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { resolveResultError } from "@/lib/api/error-message";

describe("resolveResultError", () => {
  it("业务成功（code 200）时返回空串", () => {
    expect(resolveResultError({ code: 200, msg: "" }, "project.rename_failed")).toBe("");
  });

  it("网络层失败（code 0）直接用 client 已本地化的 msg", () => {
    expect(resolveResultError({ code: 0, msg: "无法连接服务器" }, "project.rename_failed")).toBe("无法连接服务器");
  });

  it("HTTP 失败时回退到兜底文案且不为空", () => {
    const msg = resolveResultError({ code: 500, msg: "" }, "project.rename_failed");
    expect(msg).toBeTruthy();
    expect(msg).not.toBe("");
  });

  it("响应缺失（null）时不抛异常且有文案", () => {
    expect(() => resolveResultError(null, "project.rename_failed")).not.toThrow();
    expect(resolveResultError(null, "project.rename_failed")).toBeTruthy();
  });

  it("业务码非 200 但无 msg 时不返回空串", () => {
    expect(resolveResultError({ code: 400 }, "asset.update_failed")).toBeTruthy();
  });
});
