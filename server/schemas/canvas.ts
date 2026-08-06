/**
 * 画布相关请求校验模式。
 * 定义画布工程的创建与更新入参的 zod 校验规则。
 */
import { z } from "zod";

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
