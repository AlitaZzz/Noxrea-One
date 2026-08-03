import { create } from "zustand";

import { assetApi, type AssetFolderDto,type AssetItemDto } from "@/lib/api";
import type { AssetFolder, AssetItem, AssetType, CreateAssetInput, MediaType } from "@/lib/types";

// --- Helpers ---

function toTimestamp(dt: string): number {
  return new Date(dt).getTime();
}

function dtoToAsset(dto: AssetItemDto): AssetItem {
  return {
    id: String(dto.id),
    name: dto.name,
    type: dto.type as AssetType,
    mediaType: (dto.mediaType as MediaType) || "",
    width: dto.width || 0,
    height: dto.height || 0,
    description: dto.description,
    createdAt: toTimestamp(dto.createdAt),
    updatedAt: toTimestamp(dto.updatedAt),
    tags: dto.tags || [],
    metadata: dto.extraData || {},
    folderId: dto.folderId != null ? String(dto.folderId) : undefined,
    spaceKey: dto.spaceKey || "personal",
  };
}

function dtoToFolder(dto: AssetFolderDto): AssetFolder {
  return {
    id: String(dto.id),
    name: dto.name,
    spaceKey: dto.spaceKey,
    parentId: dto.parentId != null ? String(dto.parentId) : undefined,
    createdAt: toTimestamp(dto.createdAt),
    count: dto.count || 0,
  };
}

function toIntId(id: string): number | undefined {
  const n = parseInt(id, 10);
  return isNaN(n) ? undefined : n;
}

// --- Shared pagination helper ---
export const ASSET_PAGE_SIZE = 50;

export interface AssetListState {
  items: AssetItem[];
  totalCount: number;
  loading: boolean;
  loadingMore: boolean;
}

export async function fetchAssetPage(
  filters: { category?: string | string[]; search?: string; folderId?: string | null; spaceKey?: string },
  skip: number,
  limit: number = ASSET_PAGE_SIZE,
): Promise<{ items: AssetItem[]; total: number }> {
  let typeParam: string | undefined;
  if (filters.category && filters.category !== "all") {
    typeParam = Array.isArray(filters.category)
      ? filters.category.join(",")
      : filters.category;
  }
  const res = await assetApi.listAssets({
    folderId: filters.folderId ? parseInt(filters.folderId, 10) : (filters.folderId === null ? -1 : undefined),
    type: typeParam,
    search: filters.search || undefined,
    spaceKey: filters.spaceKey,
    skip,
    limit,
  });
  const data = res.data || { items: [], total: 0 };
  return {
    items: (data.items || []).map(dtoToAsset),
    total: data.total,
  };
}

// --- Store ---

interface AssetsState {
  folders: AssetFolder[];
  initialized: boolean;
  /** Lightweight set of sourceUrls already in assets (used by NodeToolbar) */
  knownAssetUrls: Set<string>;

  initialize: () => Promise<void>;
  markAssetUrlSaved: (url: string) => void;

  addAsset: (input: CreateAssetInput) => AssetItem | null;
  addAssetsBatch: (inputs: CreateAssetInput[]) => Promise<AssetItem[]>;
  updateAsset: (id: string, patch: Partial<AssetItem>) => Promise<void>;
  removeAsset: (id: string) => Promise<void>;
  updateAssetsBatch: (ids: string[], updates: Record<string, unknown>) => Promise<void>;

  addFolder: (name: string, spaceKey: string, parentId?: string) => Promise<AssetFolder | null>;
  removeFolder: (id: string) => Promise<void>;
  bumpFolderCount: (folderId: string | undefined, delta: number) => void;

  getFoldersBySpace: (spaceKey: string) => AssetFolder[];
  getChildFolders: (spaceKey: string, parentId?: string) => AssetFolder[];
}

export const useAssetsStore = create<AssetsState>((set, get) => ({
  folders: [],
  initialized: false,
  knownAssetUrls: new Set(),

  markAssetUrlSaved: (url) => {
    set((s) => {
      if (s.knownAssetUrls.has(url)) return { knownAssetUrls: s.knownAssetUrls };
      const next = new Set(s.knownAssetUrls);
      next.add(url);
      return { knownAssetUrls: next };
    });
  },

  initialize: async () => {
    if (get().initialized) return;
    try {
      const [foldersRes, urlsRes] = await Promise.all([
        assetApi.listFolders("personal"),
        assetApi.listSourceUrls("personal"),
      ]);
      const urls = new Set(urlsRes.data || []);
      set({ folders: (foldersRes.data || []).map(dtoToFolder), initialized: true, knownAssetUrls: urls });
    } catch {
      set({ folders: [], initialized: true });
    }
  },

  // --- Asset CRUD ---

  addAsset: (input) => {
    const tempId = `tmp_${Date.now()}`;
    const now = Date.now();
    const item: AssetItem = {
      id: tempId, name: input.name, type: input.type,
      width: input.width || 0, height: input.height || 0,
      description: input.description || "", createdAt: now, updatedAt: now,
      tags: input.tags || [], metadata: input.metadata || {}, folderId: input.folderId, spaceKey: input.spaceKey || "personal",
    };
    // No items array in store anymore — callers handle their own lists
    assetApi.createAsset({
      name: input.name, type: input.type,
      width: input.width, height: input.height,
      description: input.description, tags: input.tags,
      extraData: input.metadata, folderId: toIntId(input.folderId || ""), spaceKey: input.spaceKey || "personal",
    }).then((res) => {
      if (res.code === 200 && res.data) {
        const url = input.metadata?.sourceUrl;
        if (url && typeof url === "string") get().markAssetUrlSaved(url);
      }
    }).catch(() => {});

    return item;
  },

  addAssetsBatch: async (inputs) => {
    const res = await assetApi.createAssetsBatch(
      inputs.map((input) => ({
        name: input.name, type: input.type, mediaType: input.mediaType,
        width: input.width, height: input.height,
        description: input.description, tags: input.tags,
        extraData: input.metadata, folderId: toIntId(input.folderId || ""), spaceKey: input.spaceKey || "personal",
      })),
    );
    if (res.code === 200 && res.data) {
      const items = res.data.map((d: AssetItemDto) => dtoToAsset(d));
      // Mark URLs as known
      const urls = new Set<string>();
      for (const item of items) {
        const url = item.metadata?.sourceUrl;
        if (url && typeof url === "string") urls.add(url);
      }
      if (urls.size > 0) {
        set((s) => ({ knownAssetUrls: new Set([...s.knownAssetUrls, ...urls]) }));
      }
      return items;
    }
    return [];
  },

  updateAsset: async (id, patch) => {
    const intId = toIntId(id);
    if (!intId) return;
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.type !== undefined) body.type = patch.type;
    if (patch.folderId !== undefined) body.folderId = toIntId(patch.folderId);
    if (Object.keys(body).length > 0) {
      await assetApi.updateAsset(intId, body).catch(() => {});
    }
  },

  removeAsset: async (id) => {
    const intId = toIntId(id);
    if (intId) await assetApi.deleteAsset(intId).catch(() => {});
  },

  updateAssetsBatch: async (ids, updates) => {
    const intIds = ids.map(toIntId).filter((n): n is number => n != null);
    if (intIds.length > 0) {
      const body: Record<string, unknown> = {};
      if ("folderId" in updates) body.folderId = toIntId(String(updates.folderId || "")) ?? null;
      if ("type" in updates) body.type = updates.type;
      if (Object.keys(body).length > 0) {
        await assetApi.updateAssetsBatch(intIds, body).catch(() => {});
      }
    }
  },

  // --- Folder CRUD ---

  addFolder: async (name, spaceKey, parentId) => {
    const existing = get().folders.some(
      (f) => f.spaceKey === spaceKey &&
        (f.parentId || undefined) === (parentId || undefined) &&
        f.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return null;

    const tempId = `tmp_fld_${Date.now()}`;
    const folder: AssetFolder = { id: tempId, name, spaceKey, parentId, createdAt: Date.now(), count: 0 };
    set((s) => ({ folders: [...s.folders, folder] }));

    try {
      const res = await assetApi.createFolder(name, spaceKey, toIntId(parentId || ""));
      if (res.code === 200 && res.data) {
        const real = dtoToFolder(res.data as AssetFolderDto);
        set((s) => ({ folders: s.folders.map((f) => f.id === tempId ? real : f) }));
        return real;
      }
    } catch { /* fall through */ }
    set((s) => ({ folders: s.folders.filter((f) => f.id !== tempId) }));
    return null;
  },

  removeFolder: async (id) => {
    const subtree = new Set<string>([id]);
    const stack = [id];
    const { folders: rootFolders } = get();
    const byParent = new Map<string | undefined, string[]>();
    for (const f of rootFolders) {
      const list = byParent.get(f.parentId);
      if (list) list.push(f.id);
      else byParent.set(f.parentId, [f.id]);
    }
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of byParent.get(cur) ?? []) {
        subtree.add(child);
        stack.push(child);
      }
    }
    set((s) => ({ folders: s.folders.filter((f) => !subtree.has(f.id)) }));
    const intId = toIntId(id);
    if (intId) await assetApi.deleteFolder(intId).catch(() => {});
  },

  bumpFolderCount: (folderId, delta) => {
    if (!folderId) return;
    set((s) => ({
      folders: s.folders.map((f) => f.id === folderId ? { ...f, count: Math.max(0, (f.count || 0) + delta) } : f),
    }));
  },

  // --- Queries ---

  getFoldersBySpace: (spaceKey) => {
    return get().folders.filter((f) => f.spaceKey === spaceKey);
  },

  getChildFolders: (spaceKey, parentId) => {
    return get().folders.filter(
      (f) => f.spaceKey === spaceKey && (f.parentId || undefined) === (parentId || undefined),
    );
  },
}));

/**
 * 计算每个文件夹的递归资产数量（含其所有子孙子文件夹）。
 * 返回 { [folderId]: 含子孙的总数 }。
 */
export function computeRecursiveFolderCounts(folders: AssetFolder[]): Record<string, number> {
  const childrenOf = new Map<string | undefined, AssetFolder[]>();
  for (const f of folders) {
    const key = f.parentId || undefined;
    const list = childrenOf.get(key);
    if (list) list.push(f);
    else childrenOf.set(key, [f]);
  }
  const result: Record<string, number> = {};
  const calc = (f: AssetFolder): number => {
    let total = f.count || 0;
    for (const child of childrenOf.get(f.id) ?? []) total += calc(child);
    result[f.id] = total;
    return total;
  };
  // 从每个根（无父级）开始累加
  for (const f of childrenOf.get(undefined) ?? []) calc(f);
  // 兜底：父级缺失（断链）的文件夹也单独计算
  for (const f of folders) if (result[f.id] === undefined) calc(f);
  return result;
}
