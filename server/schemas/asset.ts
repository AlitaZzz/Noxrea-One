/**
 * 资产相关请求校验模式。
 * 定义文件夹与资产的创建、更新等入参的 zod 校验规则。
 */
import { z } from "zod";

// Folder
export const folderCreateSchema = z.object({
  name: z.string().min(1).max(50),
  scope: z.literal("personal").optional(),
  parentId: z.number().int().positive().nullable().optional(),
});

export const folderUpdateSchema = z.object({
  name: z.string().min(1).max(50),
});

export const folderOutSchema = z.object({
  id: z.number(),
  userId: z.number(),
  name: z.string(),
  scope: z.string(),
  kind: z.string(),
  parentId: z.number().nullable(),
  createdAt: z.string(),
  count: z.number(),
});

export type FolderCreate = z.infer<typeof folderCreateSchema>;
export type FolderUpdate = z.infer<typeof folderUpdateSchema>;
export type FolderOut = z.infer<typeof folderOutSchema>;

// Asset Item
export const assetCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().max(20).optional(),
  mediaType: z.string().max(10).optional(),
  sourceUrl: z.string().min(1).optional(),
  sourceType: z.string().max(20).optional(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  extraData: z.record(z.unknown()).optional(),
  folderId: z.number().int().positive().nullable().optional(),
  scope: z.literal("personal").optional(),
});

export const assetBatchCreateSchema = z.array(assetCreateSchema).min(1).max(200);

export const assetUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().min(1).max(20).optional(),
  mediaType: z.string().max(10).optional(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  description: z.string().optional(),
  folderId: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string()).optional(),
  extraData: z.record(z.unknown()).optional(),
});

export const assetBatchUpdateSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
  updates: z.object({
    folderId: z.number().int().positive().nullable().optional(),
    type: z.string().min(1).max(20).optional(),
  }),
});

export const assetOutSchema = z.object({
  id: z.number(),
  userId: z.number(),
  folderId: z.number(),
  scope: z.string(),
  sourceUrl: z.string().nullable(),
  sourceType: z.string(),
  name: z.string(),
  type: z.string(),
  mediaType: z.string(),
  width: z.number(),
  height: z.number(),
  description: z.string(),
  tags: z.array(z.string()),
  extraData: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AssetCreate = z.infer<typeof assetCreateSchema>;
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;
export type AssetBatchUpdate = z.infer<typeof assetBatchUpdateSchema>;
export type AssetOut = z.infer<typeof assetOutSchema>;
