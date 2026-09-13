// ============================================================
// 资产管理类型（纯类型）
// 运行时常量 ASSET_CATEGORIES 已迁移至 lib/constants.ts。
// AssetType 下沉至 lib/types/assets（供 lib/constants.ts 引用，避免 lib 反向依赖 feature），
// 此处转出以保持上层 "@features/assets/types" 导入路径不变。
// ============================================================

import type { AssetType } from "@/lib/types/assets";

export type { AssetType } from "@/lib/types/assets";

/** 资产归属范围；system 为预留值，当前业务仅启用 personal。 */
export type AssetScope = "personal" | "system";

export interface AssetFolder {
  id: string;
  name: string;
  scope: AssetScope;
  kind: "normal" | "uncategorized";
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
  prompt: string;
  folderId?: string;
  scope: AssetScope;
  sourceUrl?: string;
  sourceType?: string;
}

export interface CreateAssetInput {
  name: string;
  type: AssetType;
  mediaType?: MediaType;
  width?: number;
  height?: number;
  description?: string;
  tags?: string[];
  prompt?: string;
  sourceUrl?: string;
  sourceType?: string;
  folderId?: string;
  scope?: AssetScope;
}
