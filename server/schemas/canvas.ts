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

const canvasNodeDeltaSchema = z.object({
  upsert: z.array(z.record(z.unknown())).refine(
    (nodes) => nodes.every((node) => typeof node.id === "string" && node.id.length > 0),
    "each node must have an id",
  ),
  delete: z.array(z.string().min(1)),
});

const canvasEdgeDeltaSchema = z.object({
  upsert: z.array(z.record(z.unknown())).refine(
    (edges) => edges.every((edge) => typeof edge.id === "string" && edge.id.length > 0),
    "each edge must have an id",
  ),
  delete: z.array(z.string().min(1)),
});

/** 画布卸载兜底使用的增量保存契约；不含项目元数据。 */
export const canvasDeltaSchema = z.object({
  nodes: canvasNodeDeltaSchema,
  edges: canvasEdgeDeltaSchema,
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }).optional(),
  minimapVisible: z.boolean().optional(),
  snapToGrid: z.boolean().optional(),
  agentModel: z.string().nullable().optional(),
  baseRevision: z.number().int().min(1),
  lease: z.number().int().min(1),
});

export type CanvasDelta = Omit<z.infer<typeof canvasDeltaSchema>, "baseRevision" | "lease">;
