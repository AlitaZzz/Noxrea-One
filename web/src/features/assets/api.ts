/**
 * 资产（Assets）相关 API 封装：文件夹与资产项的增删改查。
 */
import { api } from "@/lib/api/client";

/** 与服务端 assetBatchCreateSchema 对齐的单批上限；超出时由 store 分片提交。 */
export const ASSET_BATCH_LIMIT = 200;

/** 与服务端 assetCreateSchema 对齐的素材名称长度上限。 */
export const ASSET_NAME_MAX_LENGTH = 200;

export interface AssetFolderDto {
  id: number;
  userId: number;
  name: string;
  scope: string;
  kind: string;
  parentId: number | null;
  createdAt: string;
  count: number;
}

export interface AssetItemDto {
  id: number;
  userId: number;
  folderId: number;
  scope: string;
  sourceUrl?: string | null;
  sourceType?: string;
  name: string;
  type: string;
  mediaType: string;
  width: number;
  height: number;
  description: string;
  tags: string[];
  extraData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCountersDto {
  folders: Record<string, number>;
  total: number;
}

/** 批量创建时因重复被跳过的来源；重复属正常结果，不视为失败。 */
export interface AssetSkippedDto {
  sourceUrl: string;
  reason: "already_exists" | "duplicate_in_batch";
}

export interface AssetBootstrapDto {
  folders: AssetFolderDto[];
  sourceUrls: string[];
  totalCount: number;
}

// Folders
export const assetApi = {
  bootstrap: (scope = "personal") =>
    api<AssetBootstrapDto>(`/api/assets/bootstrap?scope=${scope}`),

  listFolders: (scope = "personal") =>
    api<AssetFolderDto[]>(`/api/assets/folders?scope=${scope}`),

  createFolder: (name: string, scope = "personal", parentId?: number) =>
    api<AssetFolderDto>("/api/assets/folders", {
      method: "POST",
      body: JSON.stringify({ name, scope, parentId: parentId ?? null }),
    }),

  updateFolder: (id: number, name: string) =>
    api<AssetFolderDto>(`/api/assets/folders/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (id: number) =>
    api<{ removedCount: number; sourceUrls: string[]; counters: AssetCountersDto }>(`/api/assets/folders/${id}`, {
      method: "DELETE",
    }),

  // Assets
  listAssets: (params: { folderId?: number; type?: string; search?: string; scope?: string; skip?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params.folderId !== undefined) sp.set("folder_id", String(params.folderId));
    if (params.type) sp.set("type", params.type);
    if (params.search) sp.set("search", params.search);
    if (params.scope) sp.set("scope", params.scope);
    if (params.skip !== undefined) sp.set("skip", String(params.skip));
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return api<{ items: AssetItemDto[]; total: number }>(`/api/assets/items?${qs}`);
  },

  createAsset: (data: {
    name: string; type: string; mediaType?: string;
    sourceUrl?: string; sourceType?: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extraData?: Record<string, unknown>; folderId?: number | null; scope?: string;
  }) =>
    api<{ item: AssetItemDto; counters: AssetCountersDto }>("/api/assets/items", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  createAssetsBatch: (items: Array<{
    name: string; type: string; mediaType?: string;
    sourceUrl?: string; sourceType?: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extraData?: Record<string, unknown>; folderId?: number | null; scope?: string;
  }>) =>
    api<{ items: AssetItemDto[]; counters: AssetCountersDto; skipped: AssetSkippedDto[] }>("/api/assets/items/batch", {
      method: "POST",
      body: JSON.stringify(items),
    }),

  updateAsset: (id: number, data: Record<string, unknown>) =>
    api<{ item: AssetItemDto; counters: AssetCountersDto }>(`/api/assets/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteAssetsBatch: (ids: number[]) =>
    api<{ count: number; sourceUrls: string[]; counters: AssetCountersDto }>("/api/assets/items/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    }),

  updateAssetsBatch: (ids: number[], updates: Record<string, unknown>) =>
    api<{ count: number; counters: AssetCountersDto }>("/api/assets/items/batch", {
      method: "PUT",
      body: JSON.stringify({ ids, updates }),
    }),

  listSourceUrls: (scope = "personal") =>
    api<string[]>(`/api/assets/items/source-urls?scope=${scope}`),
};
