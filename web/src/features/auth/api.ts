/**
 * 用户认证相关 API 封装。
 * 登录 / 注册 / 获取当前用户信息 / 局部更新用户偏好。
 */
import { api } from "@/lib/api/client";

export const authApi = {
  /** 获取当前用户信息（GET /api/auth/me）。 */
  me: <T = unknown>() =>
    api<T>("/api/auth/me"),

  /** 登录（POST /api/auth/login）。返回类型由调用方泛型指定。 */
  login: <T = unknown>(username: string, password: string) =>
    api<T>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      skipUnauthorized: true,
    }),

  /** 注册（POST /api/auth/register）。返回类型由调用方泛型指定。 */
  register: <T = unknown>(username: string, password: string) =>
    api<T>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      skipUnauthorized: true,
    }),

  /** 局部更新当前用户字段（如 lastName / displayName 等）。 */
  updateMe: (patch: Record<string, unknown>) =>
    api("/api/auth/me", { method: "PUT", body: JSON.stringify(patch) }),
};
