import { describe, expect, it } from "vitest";

import {
  registerRequestSchema,
  updateMeSchema,
} from "./auth";

describe("认证请求契约", () => {
  it("注册接口不接受未持久化的 email 字段", () => {
    expect(
      registerRequestSchema.safeParse({
        username: "alice",
        password: "secret1",
        email: "alice@example.com",
      }).success,
    ).toBe(false);
  });

  it("更新当前用户接口不接受不可更新的 username 字段", () => {
    expect(updateMeSchema.safeParse({ username: "alice" }).success).toBe(false);
  });

  it("接受实际支持的注册与偏好字段", () => {
    expect(
      registerRequestSchema.safeParse({ username: "alice", password: "secret1" }).success,
    ).toBe(true);
    expect(updateMeSchema.safeParse({ language: "zh" }).success).toBe(true);
  });
});
