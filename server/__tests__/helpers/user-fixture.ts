/**
 * 认证相关测试共用的 Prisma User 行夹具。
 * overrides 用 Partial<User> 约束：schema 字段漂移时编译期即报错，而非运行时。
 */
import type { User } from "@prisma/client";

/** 登录/序列化路径用的 User 行夹具；overrides 覆盖本用例关心的字段。 */
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    username: "alice",
    hashedPassword: "h",
    role: "user",
    email: null,
    emailVerifiedAt: null,
    displayName: null,
    lastLoginAt: null,
    avatarUrl: null,
    theme: "dark",
    language: "zh",
    isActive: true,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
