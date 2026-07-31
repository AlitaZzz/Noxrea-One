import { z } from "zod";
import { toISO } from "./common";

// ── User schemas（对应 backend/app/schemas/user.py） ──

export const userOutSchema = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role: z.string(),
  theme: z.string(),
  language: z.string(),
  is_active: z.boolean(),
  is_superuser: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type UserOut = z.infer<typeof userOutSchema>;

/** Prisma camelCase → API snake_case（兼容两种格式） */
export function toUserOut(user: {
  id: number;
  username: string;
  email?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  role: string;
  theme: string;
  language: string;
  isActive?: boolean;
  is_active?: boolean;
  isSuperuser?: boolean;
  is_superuser?: boolean;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}): UserOut {
  return {
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    avatar_url: user.avatarUrl ?? user.avatar_url ?? null,
    role: user.role,
    theme: user.theme,
    language: user.language,
    is_active: user.isActive ?? user.is_active ?? false,
    is_superuser: user.isSuperuser ?? user.is_superuser ?? false,
    created_at: toISO(user.createdAt ?? user.created_at) ?? "",
    updated_at: toISO(user.updatedAt ?? user.updated_at) ?? "",
  };
}
