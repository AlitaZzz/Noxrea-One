import { z } from "zod";

// ── Auth schemas（对应 backend/app/schemas/auth.py） ──

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const registerRequestSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6),
  email: z.string().email().optional(),
});

export const loginResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
});

export const updateMeSchema = z.object({
  username: z.string().min(1).max(50).optional(),
  avatar_url: z.string().max(500).optional(),
  theme: z.string().max(10).optional(),
  language: z.string().max(10).optional(),
  password: z.string().min(6).optional(),
  old_password: z.string().optional(),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type UpdateMeRequest = z.infer<typeof updateMeSchema>;
