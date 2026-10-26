/**
 * 文件访问描述请求体（specs/storage-signed-direct-delivery.md 规则 2.1 / 2.8）。
 *
 * 只校验请求体契约（字段类型、取值范围、批量上限）。key 的可读键域属于共用读管线
 * （与「对象不存在」同响应 404），不在本模式内判定——两层错误语义必须分开。
 */
import { z } from "zod";

import { FILE_ACCESS_BATCH_LIMIT } from "@noxrea/shared/file-access";

const fileAccessItemSchema = z.object({
  key: z.string().min(1),
  /** 缺省表示原图 */
  width: z.number().int().positive().optional(),
  download: z.boolean().optional(),
  /** 只在 `download: true` 时参与附件名；清洗与补扩展名在读管线内统一处理 */
  filename: z.string().optional(),
});

export const fileAccessRequestSchema = z.object({
  items: z.array(fileAccessItemSchema).min(1).max(FILE_ACCESS_BATCH_LIMIT),
});

export type FileAccessItem = z.infer<typeof fileAccessItemSchema>;
