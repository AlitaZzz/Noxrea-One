/**
 * 资产库状态仓库。
 * 每个用户只有一个资产库；「未分类」是后端维护的真实文件夹，不再使用虚拟 ID。
 */
import { create } from "zustand";

import { ASSET_BATCH_LIMIT, assetApi, type AssetCountersDto, type AssetFolderDto, type AssetItemDto } from "@/features/assets/api";
import type { AssetFolder, AssetItem, AssetScope, AssetType, CreateAssetInput, MediaType } from "@/features/assets/types";
import { resolveResultError } from "@/lib/api/error-message";
import { showGlobalNotification } from "@/lib/global-notification";

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
    extraData: dto.extraData || {},
    folderId: String(dto.folderId),
    scope: (dto.scope as AssetScope) || "personal",
    sourceUrl: dto.sourceUrl || undefined,
    sourceType: dto.sourceType || undefined,
  };
}

function dtoToFolder(dto: AssetFolderDto): AssetFolder {
  return {
    id: String(dto.id),
    name: dto.name,
    scope: (dto.scope as AssetScope) || "personal",
    kind: dto.kind === "uncategorized" ? "uncategorized" : "normal",
    parentId: dto.parentId != null ? String(dto.parentId) : undefined,
    createdAt: toTimestamp(dto.createdAt),
    count: dto.count || 0,
  };
}

function toIntId(id: string): number | undefined {
  const n = parseInt(id, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** 写操作失败提示（store 层统一负责，UI 只处理成功分支） */
function notifyFailure(res: { code: number; msg?: string } | null, fallbackKey: string) {
  showGlobalNotification().error({
    title: resolveResultError(res, fallbackKey),
    placement: "bottomRight",
    duration: 6,
  });
}

// --- Shared pagination helper ---
export const ASSET_PAGE_SIZE = 50;

/** 批量创建结果；重复来源由后端跳过，不计入失败。 */
export interface AddAssetsBatchResult {
  /** 请求是否成功（HTTP 与业务码均为 200）；失败时 store 已弹出错误提示。 */
  ok: boolean;
  /** 实际入库的资产。 */
  items: AssetItem[];
  /** 因来源重复被后端跳过的数量。 */
  skippedCount: number;
}

export interface AssetListState {
  items: AssetItem[];
  totalCount: number;
  loading: boolean;
  loadingMore: boolean;
}

/** 分页拉取某个真实文件夹下的资产；不再支持 folderId 为 null 或 -1。 */
export async function fetchAssetPage(
  filters: { category?: string | string[]; search?: string; folderId?: string; scope?: AssetScope },
  skip: number,
  limit: number = ASSET_PAGE_SIZE,
): Promise<{ items: AssetItem[]; total: number }> {
  let typeParam: string | undefined;
  if (filters.category && filters.category !== "all") {
    typeParam = Array.isArray(filters.category) ? filters.category.join(",") : filters.category;
  }

  const res = await assetApi.listAssets({
    folderId: toIntId(filters.folderId || ""),
    type: typeParam,
    search: filters.search || undefined,
    scope: filters.scope || "personal",
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
  /** 保存过的 sourceUrl 集合，用于画布节点保存按钮状态。 */
  knownAssetUrls: Set<string>;

  initialize: () => Promise<void>;
  applyCounters: (counters: AssetCountersDto) => void;
  markAssetUrlSaved: (url: string) => void;

  addAsset: (input: CreateAssetInput) => Promise<AssetItem | null>;
  addAssetsBatch: (inputs: CreateAssetInput[]) => Promise<AddAssetsBatchResult>;
  updateAsset: (id: string, patch: Partial<AssetItem>) => Promise<boolean>;
  removeAssetsBatch: (ids: string[]) => Promise<{ ok: boolean; total?: number }>;
  updateAssetsBatch: (ids: string[], updates: Record<string, unknown>) => Promise<{ ok: boolean; total?: number }>;

  addFolder: (name: string, scope: AssetScope, parentId?: string) => Promise<
    { status: "created"; folder: AssetFolder } | { status: "duplicate" } | { status: "failed" }
  >;
  renameFolder: (id: string, name: string) => Promise<
    { status: "updated" } | { status: "duplicate" } | { status: "failed" }
  >;
  removeFolder: (id: string) => Promise<boolean>;

  getFoldersByScope: (scope: AssetScope) => AssetFolder[];
  getChildFolders: (scope: AssetScope, parentId?: string) => AssetFolder[];
  getUncategorizedFolder: (scope?: AssetScope) => AssetFolder | undefined;
}

export const useAssetsStore = create<AssetsState>((set, get) => ({
  folders: [],
  initialized: false,
  knownAssetUrls: new Set(),

  applyCounters: (counters) => {
    set((state) => ({
      folders: state.folders.map((folder) => {
        const count = counters.folders[folder.id];
        return count === undefined ? folder : { ...folder, count };
      }),
    }));
  },

  markAssetUrlSaved: (url) => {
    set((state) => {
      if (state.knownAssetUrls.has(url)) return { knownAssetUrls: state.knownAssetUrls };
      const next = new Set(state.knownAssetUrls);
      next.add(url);
      return { knownAssetUrls: next };
    });
  },

  initialize: async () => {
    if (get().initialized) return;
    try {
      const res = await assetApi.bootstrap("personal");
      const summary = res.data;
      set({
        folders: (summary?.folders || []).map(dtoToFolder),
        initialized: true,
        knownAssetUrls: new Set(summary?.sourceUrls || []),
      });
    } catch {
      set({ folders: [], initialized: true });
    }
  },

  // --- Asset CRUD ---

  addAsset: async (input) => {
    const scope = input.scope || "personal";
    const res = await assetApi.createAsset({
      name: input.name,
      type: input.type,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      description: input.description,
      tags: input.tags,
      extraData: input.extraData,
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      folderId: toIntId(input.folderId || "") ?? null,
      scope,
    }).catch(() => null);

    if (!res || res.code !== 200 || !res.data) {
      notifyFailure(res, "asset.create_failed");
      return null;
    }

    const item = dtoToAsset(res.data.item);
    get().applyCounters(res.data.counters);
    if (item.sourceUrl) get().markAssetUrlSaved(item.sourceUrl);
    return item;
  },

  addAssetsBatch: async (inputs) => {
    // 服务端单批上限为 ASSET_BATCH_LIMIT，超量批次在此分片提交并合并结果，避免整批被拒。
    const items: AssetItem[] = [];
    let skippedCount = 0;

    for (let offset = 0; offset < inputs.length; offset += ASSET_BATCH_LIMIT) {
      const chunk = inputs.slice(offset, offset + ASSET_BATCH_LIMIT);
      const res = await assetApi.createAssetsBatch(
        chunk.map((input) => ({
          name: input.name,
          type: input.type,
          mediaType: input.mediaType,
          width: input.width,
          height: input.height,
          description: input.description,
          tags: input.tags,
          extraData: input.extraData,
          sourceUrl: input.sourceUrl,
          sourceType: input.sourceType,
          folderId: toIntId(input.folderId || "") ?? null,
          scope: input.scope || "personal",
        })),
      );

      if (res.code !== 200 || !res.data) {
        // 已入库的前序分片保留；重复来源在重试时会被后端跳过，整体重试是安全的。
        notifyFailure(res, "asset.create_failed");
        return { ok: false, items, skippedCount };
      }

      const chunkItems = res.data.items.map(dtoToAsset);
      items.push(...chunkItems);
      skippedCount += res.data.skipped?.length ?? 0;
      get().applyCounters(res.data.counters);

      const urls = new Set<string>();
      for (const item of chunkItems) {
        if (item.sourceUrl) urls.add(item.sourceUrl);
      }
      // 被跳过的来源本就已在库中；本地已知集合可能因并发过期，一并补登记。
      for (const skip of res.data.skipped ?? []) urls.add(skip.sourceUrl);
      if (urls.size > 0) {
        set((state) => ({ knownAssetUrls: new Set([...state.knownAssetUrls, ...urls]) }));
      }
    }

    return { ok: true, items, skippedCount };
  },

  updateAsset: async (id, patch) => {
    const intId = toIntId(id);
    if (!intId) return false;

    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.type !== undefined) body.type = patch.type;
    if (patch.folderId !== undefined) body.folderId = toIntId(patch.folderId);
    if (Object.keys(body).length === 0) return false;

    const res = await assetApi.updateAsset(intId, body).catch(() => null);
    if (res && res.code === 200) {
      get().applyCounters(res.data.counters);
      return true;
    }
    notifyFailure(res, "asset.update_failed");
    return false;
  },

  removeAssetsBatch: async (ids) => {
    const intIds = ids.map(toIntId).filter((n): n is number => n != null);
    if (intIds.length === 0) return { ok: false };

    const res = await assetApi.deleteAssetsBatch(intIds).catch(() => null);
    if (res && res.code === 200 && res.data) {
      get().applyCounters(res.data.counters);
      if (res.data.sourceUrls.length > 0) {
        const removed = new Set(res.data.sourceUrls);
        set((state) => ({
          knownAssetUrls: new Set([...state.knownAssetUrls].filter((url) => !removed.has(url))),
        }));
      }
      return { ok: true, total: res.data.counters.total };
    }
    notifyFailure(res, "asset.delete_failed");
    return { ok: false };
  },

  updateAssetsBatch: async (ids, updates) => {
    const intIds = ids.map(toIntId).filter((n): n is number => n != null);
    if (intIds.length === 0) return { ok: false };

    const body: Record<string, unknown> = {};
    if ("folderId" in updates) body.folderId = toIntId(String(updates.folderId || "")) ?? null;
    if ("type" in updates) body.type = updates.type;
    if (Object.keys(body).length === 0) return { ok: false };

    const res = await assetApi.updateAssetsBatch(intIds, body).catch(() => null);
    if (res && res.code === 200) {
      get().applyCounters(res.data.counters);
      return { ok: true, total: res.data.counters.total };
    }
    notifyFailure(res, "asset.update_failed");
    return { ok: false };
  },

  // --- Folder CRUD ---

  addFolder: async (name, scope, parentId) => {
    const existing = get().folders.some(
      (folder) =>
        folder.scope === scope &&
        (folder.parentId || undefined) === (parentId || undefined) &&
        folder.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return { status: "duplicate" };

    const res = await assetApi.createFolder(name, scope, toIntId(parentId || "")).catch(() => null);
    if (res && res.code === 200 && res.data) {
      const folder = dtoToFolder(res.data);
      set((state) => ({ folders: [...state.folders, folder] }));
      return { status: "created", folder };
    }
    notifyFailure(res, "asset.folder_create_failed");
    return { status: "failed" };
  },

  renameFolder: async (id, name) => {
    const intId = toIntId(id);
    if (!intId) return { status: "failed" };

    const target = get().folders.find((folder) => folder.id === id);
    if (!target) return { status: "failed" };
    const duplicate = get().folders.some(
      (folder) =>
        folder.id !== id &&
        folder.scope === target.scope &&
        (folder.parentId || undefined) === (target.parentId || undefined) &&
        folder.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) return { status: "duplicate" };

    const res = await assetApi.updateFolder(intId, name).catch(() => null);
    if (res && res.code === 200 && res.data) {
      const updated = dtoToFolder(res.data);
      set((state) => ({
        folders: state.folders.map((folder) => (folder.id === id ? { ...folder, name: updated.name } : folder)),
      }));
      return { status: "updated" };
    }
    notifyFailure(res, "asset.folder_update_failed");
    return { status: "failed" };
  },

  removeFolder: async (id) => {
    const intId = toIntId(id);
    if (!intId) return false;

    const res = await assetApi.deleteFolder(intId).catch(() => null);
    if (!res || res.code !== 200) {
      notifyFailure(res, "asset.folder_delete_failed");
      return false;
    }

    // 后端已删除子树资产，这里同步移除目录树、失效来源 URL 和计数快照。
    const subtree = new Set<string>([id]);
    const stack = [id];
    const { folders } = get();
    const byParent = new Map<string | undefined, string[]>();
    for (const folder of folders) {
      const list = byParent.get(folder.parentId) ?? [];
      list.push(folder.id);
      byParent.set(folder.parentId, list);
    }
    while (stack.length) {
      const current = stack.pop()!;
      for (const child of byParent.get(current) ?? []) {
        subtree.add(child);
        stack.push(child);
      }
    }

    const deletedSourceUrls = new Set(res.data.sourceUrls || []);
    set((state) => ({
      folders: state.folders.filter((folder) => !subtree.has(folder.id)),
      knownAssetUrls: new Set([...state.knownAssetUrls].filter((url) => !deletedSourceUrls.has(url))),
    }));
    get().applyCounters(res.data.counters);
    return true;
  },

  // --- Queries ---

  getFoldersByScope: (scope) => get().folders.filter((folder) => folder.scope === scope),

  getChildFolders: (scope, parentId) => {
    return get().folders.filter(
      (folder) =>
        folder.scope === scope &&
        folder.kind === "normal" &&
        (folder.parentId || undefined) === (parentId || undefined),
    );
  },

  getUncategorizedFolder: (scope = "personal") => {
    return get().folders.find((folder) => folder.scope === scope && folder.kind === "uncategorized");
  },
}));

/**
 * 计算每个文件夹的递归资产数量（含其所有子文件夹）。
 * 输入只包含普通文件夹；未分类目录是根级固定目录，直接读取自身 count。
 */
export function computeRecursiveFolderCounts(folders: AssetFolder[]): Record<string, number> {
  const childrenOf = new Map<string | undefined, AssetFolder[]>();
  for (const folder of folders) {
    const key = folder.parentId || undefined;
    const list = childrenOf.get(key) ?? [];
    list.push(folder);
    childrenOf.set(key, list);
  }

  const result: Record<string, number> = {};
  const calculate = (folder: AssetFolder): number => {
    let total = folder.count || 0;
    for (const child of childrenOf.get(folder.id) ?? []) total += calculate(child);
    result[folder.id] = total;
    return total;
  };

  for (const folder of childrenOf.get(undefined) ?? []) calculate(folder);
  for (const folder of folders) if (result[folder.id] === undefined) calculate(folder);
  return result;
}
