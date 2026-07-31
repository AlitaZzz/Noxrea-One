import { z } from "zod";
import { toISO } from "./common";

// ── Canvas schemas（对应 backend/app/schemas/canvas.py） ──

export const canvasCreateSchema = z.object({
  name: z.string().max(200).optional(),
  canvas_data: z.record(z.unknown()).optional(),
});

export const canvasUpdateSchema = z.object({
  name: z.string().max(200).optional(),
  canvas_data: z.record(z.unknown()).optional(),
});

export const canvasOutSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  canvas_data: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CanvasCreate = z.infer<typeof canvasCreateSchema>;
export type CanvasUpdate = z.infer<typeof canvasUpdateSchema>;
export type CanvasOut = z.infer<typeof canvasOutSchema>;

/** Prisma camelCase → API snake_case（兼容两种格式） */
export function toCanvasOut(project: {
  id: number;
  userId?: number;
  user_id?: number;
  name: string;
  canvasData?: unknown;
  canvas_data?: unknown;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}): CanvasOut {
  const rawData = project.canvasData ?? project.canvas_data;
  let data: Record<string, unknown> = {};
  if (typeof rawData === "string") {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = {};
    }
  } else if (rawData && typeof rawData === "object") {
    data = rawData as Record<string, unknown>;
  }

  return {
    id: project.id,
    user_id: project.userId ?? project.user_id ?? 0,
    name: project.name,
    canvas_data: data,
    created_at: toISO(project.createdAt ?? project.created_at) ?? "",
    updated_at: toISO(project.updatedAt ?? project.updated_at) ?? "",
  };
}
