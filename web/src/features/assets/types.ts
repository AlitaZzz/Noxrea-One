// ============================================================
// 资产管理类型（纯类型）
// 运行时常量 ASSET_CATEGORIES、UNCATEGORIZED_FOLDER_ID 已迁移至 lib/constants.ts。
// ============================================================

export type AssetType = "character" | "scene" | "object" | "style" | "audio" | "other";

export interface AssetFolder {
  id: string;
  name: string;
  spaceKey: string;
  parentId?: string;
  createdAt: number;
  count: number;
}

export type MediaType = "image" | "video" | "audio" | "";

export interface AssetItem {
  id: string;
  name: string;
  type: AssetType;
  mediaType: MediaType;
  width: number;
  height: number;
  description: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  metadata: Record<string, unknown>;
  folderId?: string;
  spaceKey: string;
}

export interface CreateAssetInput {
  name: string;
  type: AssetType;
  mediaType?: MediaType;
  width?: number;
  height?: number;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  folderId?: string;
  spaceKey?: string;
}
