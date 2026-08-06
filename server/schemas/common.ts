/**
 * 通用响应与分页校验模式。
 * 定义统一的接口响应结构及分页参数等共用 zod 规则。
 */
import { z } from "zod";

export const unifiedResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    code: z.number(),
    data: dataSchema,
    msg: z.string(),
  });

/** 分页参数 */
export const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** ID 参数校验 */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** ISO 时间序列化 helper */
export function toISO(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  if (date instanceof Date) return date.toISOString();
  return new Date(date).toISOString();
}
