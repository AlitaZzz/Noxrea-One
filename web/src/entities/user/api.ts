/**
 * 用户认证 API 封装（entity 内部使用，不对外导出）。
 * 登录 / 注册 / 获取当前用户信息 / 局部更新用户偏好 / 登出。
 */
import { api } from "@/lib/api/client";

import type { MeResponse, ProfilePatch } from "./types";

export const authApi = {
  /** 获取当前用户信息（GET /api/auth/me）。空响应体（无登录态）返回 null。 */
  me: () => api<MeResponse | null>("/api/auth/me"),

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

  /** 局部更新当前用户字段（头像、主题、语言、密码）。username 为登录身份，不可修改。空响应体返回 null。 */
  updateMe: (patch: ProfilePatch) =>
    api<MeResponse | null>("/api/auth/me", { method: "PUT", body: JSON.stringify(patch) }),

  /** 登出：服务端过期 httpOnly 鉴权 cookie（幂等）。 */
  logout: () => api("/api/auth/logout", { method: "POST", skipUnauthorized: true }),
};
