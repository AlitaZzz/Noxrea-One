/**
 * 认证相关请求校验模式。
 * 定义登录、注册等认证入参的 zod 校验规则。
 */
import { z } from "zod";

import { isStorageKey } from "@noxrea/shared/url";

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const registerRequestSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6),
}).strict();

export const loginResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
});

export const updateMeSchema = z.object({
  // 头像引用：存储 key（{userId}/{hash[:2]}/{hash}{ext}）；头像只来自上传，无外部 URL 值域
  avatarKey: z.string().refine(isStorageKey, { message: "头像引用须为存储 key" }).optional(),
  theme: z.string().max(10).optional(),
  language: z.string().max(10).optional(),
  password: z.string().min(6).optional(),
  oldPassword: z.string().optional(),
}).strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type UpdateMeRequest = z.infer<typeof updateMeSchema>;
