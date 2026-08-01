import { z } from "zod";

// ── Canvas schemas（对应 backend/app/schemas/canvas.py） ──

export const canvasCreateSchema = z.object({
  name: z.string().max(200).optional(),
  canvasData: z.record(z.unknown()).optional(),
});

export const canvasUpdateSchema = z.object({
  name: z.string().max(200).optional(),
  canvasData: z.record(z.unknown()).optional(),
});

export const canvasOutSchema = z.object({
  id: z.number(),
  userId: z.number(),
  name: z.string(),
  canvasData: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CanvasCreate = z.infer<typeof canvasCreateSchema>;
export type CanvasUpdate = z.infer<typeof canvasUpdateSchema>;
export type CanvasOut = z.infer<typeof canvasOutSchema>;
