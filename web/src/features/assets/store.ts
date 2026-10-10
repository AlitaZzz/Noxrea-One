/**
 * 资产库状态仓库。
 * 每个用户只有一个资产库；「未分类」是后端维护的真实文件夹，不再使用虚拟 ID。
 */
import { create } from "zustand";

import { ASSET_BATCH_LIMIT, assetApi, type AssetCountersDto, type AssetFolderDto, type AssetItemDto, type AssetSkippedDto } from "@/features/assets/api";
import type { AssetFolder, AssetItem, AssetScope, AssetType, CreateAssetInput, MediaType } from "@/features/assets/types";
import { notifyFailure } from "@/lib/global-notification";
import { captureSession, onSessionChange, SessionChangedError } from "@/lib/session-lifecycle";

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
    size: dto.size || 0,
    duration: dto.duration || 0,
    description: dto.description,
    createdAt: toTimestamp(dto.createdAt),
    updatedAt: toTimestamp(dto.updatedAt),
    tags: dto.tags || [],
    prompt: dto.prompt || "",
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

/** 把本次操作涉及的来源 URL 从本地已知集合移除（删除/取消收藏后同步收藏状态）。 */
function removeKnownAssetUrls(sourceUrls: string[]): void {
  if (sourceUrls.length === 0) return;
  const removed = new Set(sourceUrls);
  useAssetsStore.setState((state) => ({
    knownAssetUrls: new Set([...state.knownAssetUrls].filter((url) => !removed.has(url))),
  }));
}

/**
 * 按服务端单批上限（ASSET_BATCH_LIMIT）分片顺序提交一批按 id 的操作，避免整批 422。
 * 每个成功分片即时应用计数快照并失效资产视图（打开中的列表会重拉，已删条目即时消失）；
 * 某分片失败时保留已完成分片的进度（total 为最后成功快照）并上报，调用方返回 { ok: false, total }。
 */
async function submitIdBatches(
  session: ReturnType<typeof captureSession>,
  ids: number[],
  failureKey: "asset.delete_failed" | "asset.update_failed",
  submit: (chunk: number[]) => Promise<{ counters: AssetCountersDto; sourceUrls?: string[] }>,
): Promise<{ ok: boolean; total?: number }> {
  let total: number | undefined;
  for (let offset = 0; offset < ids.length; offset += ASSET_BATCH_LIMIT) {
    const chunk = ids.slice(offset, offset + ASSET_BATCH_LIMIT);
    let data: { counters: AssetCountersDto; sourceUrls?: string[] };
    try {
      data = await session.run(() => submit(chunk));
      session.assertCurrent();
    } catch (e) {
      notifyFailure(e, failureKey);
      return { ok: false, total };
    }
    useAssetsStore.getState().applyCounters(data.counters);
    total = data.counters.total;
    useAssetsStore.getState().noteLibraryChanged();
    if (data.sourceUrls) removeKnownAssetUrls(data.sourceUrls);
  }
  return { ok: true, total };
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

export function selectChildFolders(
  folders: AssetFolder[],
  scope: AssetScope,
  parentId?: string,
): AssetFolder[] {
  return folders.filter(
    (folder) =>
      folder.scope === scope &&
      folder.kind === "normal" &&
      (folder.parentId || undefined) === (parentId || undefined),
  );
}

/**
 * 由列表中某条资产构造 keyset 游标，指向该条之后（更旧）的记录。
 * 协议须与服务端 parseAssetCursor 一致：`<createdAt 毫秒>_<id>`。
 */
export function encodeAssetCursor(item: Pick<AssetItem, "createdAt" | "id">): string | null {
  if (!Number.isFinite(item.createdAt) || !/^\d+$/.test(item.id)) return null;
  return `${item.createdAt}_${item.id}`;
}

/** 分页拉取某个真实文件夹下的资产；cursor 为空/首页，否则从游标之后取下一页。 */
export async function fetchAssetPage(
  filters: { category?: string | string[]; search?: string; folderId?: string; scope?: AssetScope },
  cursor?: string | null,
  limit: number = ASSET_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<{ items: AssetItem[]; total: number; nextCursor: string | null }> {
  const session = captureSession();
  let typeParam: string | undefined;
  if (filters.category && filters.category !== "all") {
    typeParam = Array.isArray(filters.category) ? filters.category.join(",") : filters.category;
  }

  const data = await session.run(() => assetApi.listAssets({
    folderId: toIntId(filters.folderId || ""),
    type: typeParam,
    search: filters.search || undefined,
    scope: filters.scope || "personal",
    cursor: cursor || undefined,
    limit,
    signal,
  }));
  session.assertCurrent();
  return {
    items: (data.items || []).map(dtoToAsset),
    total: data.total,
    nextCursor: data.nextCursor ?? null,
  };
}

// --- Store ---

interface AssetsState {
  folders: AssetFolder[];
  /**
   * 拉取成功（含空列表）为 true；失败保持 false 以允许重试。
   * 画布门页在拉取 settle 后凭它区分「就绪」与「失败」——
   * 吞掉失败置 true 会让空素材库与网络故障不可区分。
   */
  initialized: boolean;
  /** 保存过的 sourceUrl 集合，用于画布节点保存按钮状态。 */
  knownAssetUrls: Set<string>;
  /**
   * 资产条目变更令牌（查询失效信号）：任何增删改成功后自增。
   * 资产视图（画布抽屉 / 管理弹窗）在打开期间订阅它触发重拉，
   * 让「画布收藏」这类发生在视图外的变更能实时反映到已打开的列表里。
   */
  libraryVersion: number;
  noteLibraryChanged: () => void;

  initialize: () => Promise<void>;
  applyCounters: (counters: AssetCountersDto) => void;
  markAssetUrlSaved: (url: string) => void;

  addAsset: (input: CreateAssetInput) => Promise<AssetItem | null>;
  addAssetsBatch: (inputs: CreateAssetInput[]) => Promise<AddAssetsBatchResult>;
  updateAsset: (id: string, patch: Partial<AssetItem>) => Promise<boolean>;
  removeAssetsBatch: (ids: string[]) => Promise<{ ok: boolean; total?: number }>;
  /** 画布「取消收藏」：按 sourceUrl 删除个人库条目，并同步 knownAssetUrls。 */
  unsaveAssetsByUrls: (urls: string[]) => Promise<boolean>;
  updateAssetsBatch: (ids: string[], updates: Record<string, unknown>) => Promise<{ ok: boolean; total?: number }>;

  addFolder: (name: string, scope: AssetScope, parentId?: string) => Promise<
    { status: "created"; folder: AssetFolder } | { status: "duplicate" } | { status: "failed" }
  >;
  renameFolder: (id: string, name: string) => Promise<
    { status: "updated" } | { status: "duplicate" } | { status: "failed" }
  >;
  removeFolder: (id: string) => Promise<boolean>;

  getUncategorizedFolder: (scope?: AssetScope) => AssetFolder | undefined;
}

/**
 * initialize 的在途 promise：并发调用（StrictMode 双挂载 / 多调用方）共享同一次拉取。
 * 在途引用随会话重置；失败后允许重试。
 */
let assetsInitInFlight: Promise<void> | null = null;

export const useAssetsStore = create<AssetsState>((set, get) => ({
  folders: [],
  initialized: false,
  knownAssetUrls: new Set(),
  libraryVersion: 0,
  noteLibraryChanged: () => set((state) => ({ libraryVersion: state.libraryVersion + 1 })),

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

  initialize: () => {
    if (get().initialized) return Promise.resolve();
    if (assetsInitInFlight) return assetsInitInFlight;
    const session = captureSession();
    const pending = (async () => {
      try {
        const summary = await session.run(() => assetApi.bootstrap("personal"));
        session.assertCurrent();
        set({
          folders: (summary?.folders || []).map(dtoToFolder),
          initialized: true,
          knownAssetUrls: new Set(summary?.sourceUrls || []),
        });
      } catch {
        // 失败保持 initialized=false：门页在 settle 后凭它判失败并重试
      }
    })().finally(() => {
      if (assetsInitInFlight === pending) assetsInitInFlight = null;
    });
    assetsInitInFlight = pending;
    return pending;
  },

  // --- Asset CRUD ---

  addAsset: async (input) => {
    const session = captureSession();
    const scope = input.scope || "personal";
    let data: { item: AssetItemDto; counters: AssetCountersDto };
    try {
      data = await session.run(() => assetApi.createAsset({
        name: input.name,
        type: input.type,
        mediaType: input.mediaType,
        description: input.description,
        tags: input.tags,
        prompt: input.prompt,
        sourceUrl: input.sourceUrl,
        sourceType: input.sourceType,
        folderId: toIntId(input.folderId || "") ?? null,
        scope,
      }));
      session.assertCurrent();
    } catch (e) {
      notifyFailure(e, "asset.create_failed");
      return null;
    }

    const item = dtoToAsset(data.item);
    get().applyCounters(data.counters);
    if (item.sourceUrl) get().markAssetUrlSaved(item.sourceUrl);
    get().noteLibraryChanged();
    return item;
  },

  addAssetsBatch: async (inputs) => {
    const session = captureSession();
    // 服务端单批上限为 ASSET_BATCH_LIMIT，超量批次在此分片提交并合并结果，避免整批被拒。
    const items: AssetItem[] = [];
    let skippedCount = 0;

    for (let offset = 0; offset < inputs.length; offset += ASSET_BATCH_LIMIT) {
      const chunk = inputs.slice(offset, offset + ASSET_BATCH_LIMIT);
      let data: {
        items: AssetItemDto[];
        counters: AssetCountersDto;
        skipped: AssetSkippedDto[];
      };
      try {
        data = await session.run(() => assetApi.createAssetsBatch(
          chunk.map((input) => ({
            name: input.name,
            type: input.type,
            mediaType: input.mediaType,
            description: input.description,
            tags: input.tags,
            prompt: input.prompt,
            sourceUrl: input.sourceUrl,
            sourceType: input.sourceType,
            folderId: toIntId(input.folderId || "") ?? null,
            scope: input.scope || "personal",
          })),
        ));
        session.assertCurrent();
      } catch (e) {
        // 已入库的前序分片保留；重复来源在重试时会被后端跳过，整体重试是安全的。
        notifyFailure(e, "asset.create_failed");
        return e instanceof SessionChangedError
          ? { ok: false, items: [], skippedCount: 0 }
          : { ok: false, items, skippedCount };
      }

      const chunkItems = data.items.map(dtoToAsset);
      items.push(...chunkItems);
      skippedCount += data.skipped?.length ?? 0;
      get().applyCounters(data.counters);
      // 每个成功分片即时失效：后续分片失败提前返回时，已入库的条目也能让视图刷新。
      if (chunkItems.length > 0) get().noteLibraryChanged();

      const urls = new Set<string>();
      for (const item of chunkItems) {
        if (item.sourceUrl) urls.add(item.sourceUrl);
      }
      // 被跳过的来源本就已在库中；本地已知集合可能因并发过期，一并补登记。
      for (const skip of data.skipped ?? []) urls.add(skip.sourceUrl);
      if (urls.size > 0) {
        set((state) => ({ knownAssetUrls: new Set([...state.knownAssetUrls, ...urls]) }));
      }
    }

    return { ok: true, items, skippedCount };
  },

  updateAsset: async (id, patch) => {
    const session = captureSession();
    const intId = toIntId(id);
    if (!intId) return false;

    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.type !== undefined) body.type = patch.type;
    if (patch.folderId !== undefined) body.folderId = toIntId(patch.folderId);
    if (patch.tags !== undefined) body.tags = patch.tags;
    if (patch.prompt !== undefined) body.prompt = patch.prompt;
    if (Object.keys(body).length === 0) return false;

    try {
      const data = await session.run(() => assetApi.updateAsset(intId, body));
      session.assertCurrent();
      get().applyCounters(data.counters);
      get().noteLibraryChanged();
      return true;
    } catch (e) {
      notifyFailure(e, "asset.update_failed");
      return false;
    }
  },

  removeAssetsBatch: async (ids) => {
    const intIds = ids.map(toIntId).filter((n): n is number => n != null);
    if (intIds.length === 0) return { ok: false };

    return submitIdBatches(captureSession(), intIds, "asset.delete_failed", (chunk) =>
      assetApi.deleteAssetsBatch(chunk));
  },

  unsaveAssetsByUrls: async (urls) => {
    const session = captureSession();
    if (urls.length === 0) return false;
    try {
      const data = await session.run(() => assetApi.deleteAssetsBySource(urls));
      session.assertCurrent();
      get().applyCounters(data.counters);
      get().noteLibraryChanged();
      removeKnownAssetUrls(data.sourceUrls);
      return true;
    } catch (e) {
      notifyFailure(e, "asset.delete_failed");
      return false;
    }
  },

  updateAssetsBatch: async (ids, updates) => {
    const intIds = ids.map(toIntId).filter((n): n is number => n != null);
    if (intIds.length === 0) return { ok: false };

    const body: Record<string, unknown> = {};
    if ("folderId" in updates) body.folderId = toIntId(String(updates.folderId || "")) ?? null;
    if ("type" in updates) body.type = updates.type;
    if (Object.keys(body).length === 0) return { ok: false };

    return submitIdBatches(captureSession(), intIds, "asset.update_failed", (chunk) =>
      assetApi.updateAssetsBatch(chunk, body));
  },

  // --- Folder CRUD ---

  addFolder: async (name, scope, parentId) => {
    const session = captureSession();
    const existing = get().folders.some(
      (folder) =>
        folder.scope === scope &&
        (folder.parentId || undefined) === (parentId || undefined) &&
        folder.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return { status: "duplicate" };

    try {
      const folder = dtoToFolder(await session.run(() => assetApi.createFolder(name, scope, toIntId(parentId || ""))));
      session.assertCurrent();
      set((state) => ({ folders: [...state.folders, folder] }));
      return { status: "created", folder };
    } catch (e) {
      notifyFailure(e, "asset.folder_create_failed");
      return { status: "failed" };
    }
  },

  renameFolder: async (id, name) => {
    const session = captureSession();
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

    try {
      const updated = dtoToFolder(await session.run(() => assetApi.updateFolder(intId, name)));
      session.assertCurrent();
      set((state) => ({
        folders: state.folders.map((folder) => (folder.id === id ? { ...folder, name: updated.name } : folder)),
      }));
      return { status: "updated" };
    } catch (e) {
      notifyFailure(e, "asset.folder_update_failed");
      return { status: "failed" };
    }
  },

  removeFolder: async (id) => {
    const session = captureSession();
    const intId = toIntId(id);
    if (!intId) return false;

    let data: { sourceUrls: string[]; counters: AssetCountersDto };
    try {
      data = await session.run(() => assetApi.deleteFolder(intId));
      session.assertCurrent();
    } catch (e) {
      notifyFailure(e, "asset.folder_delete_failed");
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

    const deletedSourceUrls = new Set(data.sourceUrls || []);
    set((state) => ({
      folders: state.folders.filter((folder) => !subtree.has(folder.id)),
      knownAssetUrls: new Set([...state.knownAssetUrls].filter((url) => !deletedSourceUrls.has(url))),
    }));
    get().applyCounters(data.counters);
    return true;
  },

  // --- Queries ---

  getUncategorizedFolder: (scope = "personal") => {
    return get().folders.find((folder) => folder.scope === scope && folder.kind === "uncategorized");
  },
}));

onSessionChange(() => {
  assetsInitInFlight = null;
  useAssetsStore.setState({ folders: [], initialized: false, knownAssetUrls: new Set(), libraryVersion: 0 });
});

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
