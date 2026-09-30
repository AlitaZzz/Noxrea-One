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
  // 用户自定义封面（/api/files/... URL）；null 表示清除封面。
  // 纯元数据：与 name 同语义，不参与版本判定、不递增 revision
  coverUrl: z.string().max(2000).nullable().optional(),
  // 仅改名（无 canvasData）可省略；带 canvasData 的画布保存必须携带，由路由层强制校验
  baseRevision: z.number().int().min(1).optional(),
  // 编辑权租约令牌（fencing token）：与 baseRevision 配对，由路由层强制校验；
  // 服务端在写临界区内比对当前令牌，被接管的旧持有者凭旧令牌写入会被拒绝
  lease: z.number().int().min(1).optional(),
});
