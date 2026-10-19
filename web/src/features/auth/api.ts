/**
 * 用户认证相关 API 封装。
 * 登录 / 注册 / 获取当前用户信息 / 局部更新用户偏好。
 */
import { api } from "@/lib/api/client";

import type { UserInfo } from "./user-cache";

/** 存储摘要（specs/storage-user-quota.md 规则 5）：quotaBytes 为 null 表示不限量 */
export interface StorageSummary {
  usedBytes: number;
  quotaBytes: number | null;
}

/** GET/PUT /api/auth/me 响应：用户契约字段 + 存储摘要（两处理器恒组合，同资源表示一致） */
export interface MeResponse extends UserInfo {
  storage: StorageSummary;
}

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
  updateMe: (patch: Record<string, unknown>) =>
    api<MeResponse | null>("/api/auth/me", { method: "PUT", body: JSON.stringify(patch) }),

  /** 登出：服务端过期 httpOnly 鉴权 cookie（幂等）。 */
  logout: () => api("/api/auth/logout", { method: "POST", skipUnauthorized: true }),
};
