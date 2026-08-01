import { z } from "zod";

// ── User schemas（对应 backend/app/schemas/user.py） ──

export const userOutSchema = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.string(),
  theme: z.string(),
  language: z.string(),
  isActive: z.boolean(),
  isSuperuser: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type UserOut = z.infer<typeof userOutSchema>;
