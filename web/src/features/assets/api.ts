/**
 * 资产（Assets）相关 API 封装：文件夹与资产项的增删改查。
 */
import { api } from "@/lib/api/client";

export interface AssetFolderDto {
  id: number;
  userId: number;
  name: string;
  spaceKey: string;
  parentId: number | null;
  createdAt: string;
  count: number;
}

export interface AssetItemDto {
  id: number;
  userId: number;
  folderId: number | null;
  spaceKey: string;
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

// Folders
export const assetApi = {
  listFolders: (spaceKey = "personal") =>
    api<AssetFolderDto[]>(`/api/assets/folders?space_key=${spaceKey}`),

  createFolder: (name: string, spaceKey = "personal", parentId?: number) =>
    api<AssetFolderDto>("/api/assets/folders", {
      method: "POST",
      body: JSON.stringify({ name, spaceKey, parentId: parentId ?? null }),
    }),

  updateFolder: (id: number, name: string) =>
    api<AssetFolderDto>(`/api/assets/folders/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (id: number) =>
    api(`/api/assets/folders/${id}`, { method: "DELETE" }),

  // Assets
  listAssets: (params?: { folderId?: number; type?: string; search?: string; spaceKey?: string; skip?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.folderId !== undefined) sp.set("folder_id", String(params.folderId));
    if (params?.type) sp.set("type", params.type);
    if (params?.search) sp.set("search", params.search);
    if (params?.spaceKey) sp.set("space_key", params.spaceKey);
    if (params?.skip !== undefined) sp.set("skip", String(params.skip));
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return api<{ items: AssetItemDto[]; total: number }>(`/api/assets/items${qs ? `?${qs}` : ""}`);
  },

  createAsset: (data: {
    name: string; type: string; mediaType?: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extraData?: Record<string, unknown>; folderId?: number; spaceKey?: string;
  }) =>
    api<AssetItemDto>("/api/assets/items", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  createAssetsBatch: (items: Array<{
    name: string; type: string; mediaType?: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extraData?: Record<string, unknown>; folderId?: number; spaceKey?: string;
  }>) =>
    api<AssetItemDto[]>("/api/assets/items/batch", {
      method: "POST",
      body: JSON.stringify(items),
    }),

  updateAsset: (id: number, data: Record<string, unknown>) =>
    api<AssetItemDto>(`/api/assets/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteAsset: (id: number) =>
    api(`/api/assets/items/${id}`, { method: "DELETE" }),

  updateAssetsBatch: (ids: number[], updates: Record<string, unknown>) =>
    api<{ count: number }>("/api/assets/items/batch", {
      method: "PUT",
      body: JSON.stringify({ ids, updates }),
    }),

  listSourceUrls: (spaceKey = "personal") =>
    api<string[]>(`/api/assets/items/source-urls?space_key=${spaceKey}`),
};
