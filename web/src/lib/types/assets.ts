// ============================================================
// 资产管理类型
// ============================================================

export type AssetType = "character" | "scene" | "object" | "style" | "audio" | "other";

export const ASSET_CATEGORIES: { key: AssetType | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "asset.cat.all" },
  { key: "character", labelKey: "asset.cat.character" },
  { key: "scene", labelKey: "asset.cat.scene" },
  { key: "object", labelKey: "asset.cat.object" },
  { key: "style", labelKey: "asset.cat.style" },
  { key: "audio", labelKey: "asset.cat.audio" },
  { key: "other", labelKey: "asset.cat.other" },
];

export interface AssetFolder {
  id: string;
  name: string;
  spaceKey: string;
  parentId?: string;
  createdAt: number;
  count: number;
}

/** 虚拟「未分类」文件夹的 ID：代表 folder_id 为 NULL 的资产集合（不落库） */
export const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";

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
