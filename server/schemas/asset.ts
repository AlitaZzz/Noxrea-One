import { z } from "zod";
import { toISO } from "./common";

// ── Asset schemas（对应 backend/app/schemas/asset.py） ──

// Folder
export const folderCreateSchema = z.object({
  name: z.string().min(1).max(50),
  space_key: z.string().max(20).optional(),
  parent_id: z.number().int().positive().nullable().optional(),
});

export const folderUpdateSchema = z.object({
  name: z.string().min(1).max(50),
});

export const folderOutSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  space_key: z.string(),
  parent_id: z.number().nullable(),
  created_at: z.string(),
  count: z.number(),
});

export type FolderCreate = z.infer<typeof folderCreateSchema>;
export type FolderUpdate = z.infer<typeof folderUpdateSchema>;
export type FolderOut = z.infer<typeof folderOutSchema>;

export function toFolderOut(folder: {
  id: number;
  userId?: number;
  user_id?: number;
  name: string;
  spaceKey?: string;
  space_key?: string;
  parentId?: number | null;
  parent_id?: number | null;
  createdAt?: Date | string;
  created_at?: Date | string;
  _count?: { items?: number };
  count?: number;
}): FolderOut {
  const itemCount = folder._count?.items ?? folder.count ?? 0;
  const uid = folder.userId ?? folder.user_id ?? 0;
  const sk = folder.spaceKey ?? folder.space_key ?? "personal";
  const pid = folder.parentId ?? folder.parent_id ?? null;
  const ca = folder.createdAt ?? folder.created_at ?? new Date();
  return {
    id: folder.id,
    user_id: uid,
    name: folder.name,
    space_key: sk,
    parent_id: pid,
    created_at: toISO(ca) ?? "",
    count: itemCount,
  };
}

// Asset Item
export const assetCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().max(20).optional(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  extra_data: z.record(z.unknown()).optional(),
  folder_id: z.number().int().positive().nullable().optional(),
  space_key: z.string().max(20).optional(),
});

export const assetBatchCreateSchema = z.array(assetCreateSchema);

export const assetUpdateSchema = z.record(z.unknown());

export const assetBatchUpdateSchema = z.object({
  ids: z.array(z.number().int().positive()),
  updates: z.record(z.unknown()),
});

export const assetOutSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  folder_id: z.number().nullable(),
  space_key: z.string(),
  name: z.string(),
  type: z.string(),
  width: z.number(),
  height: z.number(),
  description: z.string(),
  tags: z.array(z.string()),
  extra_data: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AssetCreate = z.infer<typeof assetCreateSchema>;
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;
export type AssetBatchUpdate = z.infer<typeof assetBatchUpdateSchema>;
export type AssetOut = z.infer<typeof assetOutSchema>;

export function toAssetOut(item: {
  id: number;
  userId?: number;
  user_id?: number;
  folderId?: number | null;
  folder_id?: number | null;
  spaceKey?: string;
  space_key?: string;
  name: string;
  type: string;
  width: number;
  height: number;
  description: string;
  tags: unknown;
  extraData?: unknown;
  extra_data?: unknown;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}): AssetOut {
  const parseArr = (raw: unknown): string[] => {
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return []; }
    }
    if (Array.isArray(raw)) return raw as string[];
    return [];
  };

  const parseObj = (raw: unknown): Record<string, unknown> => {
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    return {};
  };

  return {
    id: item.id,
    user_id: item.userId ?? item.user_id ?? 0,
    folder_id: item.folderId ?? item.folder_id ?? null,
    space_key: item.spaceKey ?? item.space_key ?? "personal",
    name: item.name,
    type: item.type,
    width: item.width,
    height: item.height,
    description: item.description,
    tags: parseArr(item.tags),
    extra_data: parseObj(item.extraData ?? item.extra_data),
    created_at: toISO(item.createdAt ?? item.created_at) ?? "",
    updated_at: toISO(item.updatedAt ?? item.updated_at) ?? "",
  };
}
