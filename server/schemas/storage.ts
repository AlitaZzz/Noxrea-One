/**
 * 存储直传请求校验模式（specs/storage-s3-backend.md 业务规则 6）。
 * 哈希一律 64 位小写十六进制（SHA256），与 file_objects.hash 同一命名空间。
 */
import { z } from "zod";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const uploadTicketSchema = z.object({
  hash: sha256Hex,
  size: z.number().int().positive(),
  name: z.string().min(1).max(255),
  content_type: z.string().max(100).optional(),
});

export const uploadCompleteSchema = z.object({
  staging_key: z.string().min(1).max(200),
  hash: sha256Hex,
  name: z.string().min(1).max(255),
  content_type: z.string().max(100).optional(),
  // 与中转上传的 ?source= 同口：画布加工派生文件标记 derived
  source: z.enum(["upload", "derived"]).optional(),
});
