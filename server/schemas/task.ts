import { z } from "zod";
import { toISO } from "./common";

// ── Task schemas（对应 backend/app/schemas/task.py） ──

export const taskCreateSchema = z.object({
  type: z.string().max(30).optional(),
  capability: z.string().max(30).optional(),
  protocol: z.string().max(30).optional(),
  model: z.string().max(200).optional(),
  channel_id: z.number().int().positive().optional(),
  prompt: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  ref_images: z.array(z.string()).optional(),
  node_id: z.string().optional(),
});

export const taskOutSchema = z.object({
  id: z.string(),
  user_id: z.number(),
  type: z.string(),
  capability: z.string().nullable(),
  protocol: z.string().nullable(),
  model: z.string().nullable(),
  upstream_task_id: z.string().nullable(),
  status: z.string(),
  prompt: z.string(),
  config: z.record(z.unknown()),
  ref_images: z.array(z.string()).nullable(),
  result_urls: z.array(z.string()).nullable(),
  result_text: z.string().nullable(),
  error: z.string().nullable(),
  node_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskOut = z.infer<typeof taskOutSchema>;

/** Prisma camelCase → API snake_case（兼容两种格式） */
export function toTaskOut(task: {
  id: string;
  userId?: number;
  user_id?: number;
  type: string;
  capability: string | null;
  protocol: string | null;
  model: string | null;
  upstreamTaskId?: string | null;
  upstream_task_id?: string | null;
  status: string;
  prompt: string;
  config: unknown;
  refImages?: unknown;
  ref_images?: unknown;
  resultUrls?: unknown;
  result_urls?: unknown;
  resultText?: string | null;
  result_text?: string | null;
  error: string | null;
  nodeId?: string;
  node_id?: string;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}): TaskOut {
  const parseJson = (raw: unknown): Record<string, unknown> => {
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    return {};
  };

  const parseJsonArray = (raw: unknown): string[] | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return null; }
    }
    if (Array.isArray(raw)) return raw as string[];
    return null;
  };

  return {
    id: task.id,
    user_id: task.userId ?? task.user_id ?? 0,
    type: task.type,
    capability: task.capability,
    protocol: task.protocol,
    model: task.model,
    upstream_task_id: task.upstreamTaskId ?? task.upstream_task_id ?? null,
    status: task.status,
    prompt: task.prompt,
    config: parseJson(task.config),
    ref_images: parseJsonArray(task.refImages ?? task.ref_images),
    result_urls: parseJsonArray(task.resultUrls ?? task.result_urls),
    result_text: task.resultText ?? task.result_text ?? null,
    error: task.error,
    node_id: task.nodeId ?? task.node_id ?? "",
    created_at: toISO(task.createdAt ?? task.created_at) ?? "",
    updated_at: toISO(task.updatedAt ?? task.updated_at) ?? "",
  };
}
