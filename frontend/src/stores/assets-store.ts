import { create } from "zustand";
import type { AssetItem, AssetFolder, CreateAssetInput, AssetType } from "@/lib/types";
import { assetApi, type AssetItemDto, type AssetFolderDto } from "@/lib/api";

// --- Helpers ---

function toTimestamp(dt: string): number {
  return new Date(dt).getTime();
}

function dtoToAsset(dto: AssetItemDto): AssetItem {
  return {
    id: String(dto.id),
    name: dto.name,
    type: dto.type as AssetType,
    width: dto.width || 0,
    height: dto.height || 0,
    description: dto.description,
    createdAt: toTimestamp(dto.created_at),
    updatedAt: toTimestamp(dto.updated_at),
    tags: dto.tags || [],
    metadata: dto.extra_data || {},
    folderId: dto.folder_id != null ? String(dto.folder_id) : undefined,
    spaceKey: dto.space_key || "personal",
  };
}

function dtoToFolder(dto: AssetFolderDto): AssetFolder {
  return {
    id: String(dto.id),
    name: dto.name,
    spaceKey: dto.space_key,
    parentId: dto.parent_id != null ? String(dto.parent_id) : undefined,
    createdAt: toTimestamp(dto.created_at),
  };
}

function toIntId(id: string): number | undefined {
  const n = parseInt(id, 10);
  return isNaN(n) ? undefined : n;
}

// --- Store ---

interface AssetsState {
  items: AssetItem[];
  folders: AssetFolder[];
  initialized: boolean;
  loading: boolean;

  initialize: () => Promise<void>;

  addAsset: (input: CreateAssetInput) => AssetItem | null;
  addAssetsBatch: (inputs: CreateAssetInput[]) => Promise<AssetItem[]>;
  updateAsset: (id: string, patch: Partial<AssetItem>) => Promise<void>;
  removeAsset: (id: string) => Promise<void>;
  updateAssetsBatch: (ids: string[], updates: Record<string, unknown>) => Promise<void>;

  addFolder: (name: string, spaceKey: string, parentId?: string) => Promise<AssetFolder | null>;
  removeFolder: (id: string) => Promise<void>;

  getFiltered: (category: AssetType | "all", search: string, folderId?: string | null, spaceKey?: string) => AssetItem[];
  getFoldersBySpace: (spaceKey: string) => AssetFolder[];
  getChildFolders: (spaceKey: string, parentId?: string) => AssetFolder[];
}

export const useAssetsStore = create<AssetsState>((set, get) => ({
  items: [],
  folders: [],
  initialized: false,
  loading: false,

  initialize: async () => {
    if (get().initialized) return;
    set({ loading: true });
    try {
      const [foldersRes, assetsRes] = await Promise.all([
        assetApi.listFolders("personal"),
        assetApi.listAssets(),
      ]);
      set({
        items: (assetsRes.data || []).map(dtoToAsset),
        folders: (foldersRes.data || []).map(dtoToFolder),
        initialized: true,
        loading: false,
      });
    } catch {
      set({ items: [], folders: [], initialized: true, loading: false });
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
    set((s) => ({ items: [item, ...s.items] }));

    assetApi.createAsset({
      name: input.name, type: input.type,
      width: input.width, height: input.height,
      description: input.description, tags: input.tags,
      extra_data: input.metadata, folder_id: toIntId(input.folderId || ""), space_key: input.spaceKey || "personal",
    }).then((res) => {
      if (res.code === 200 && res.data) {
        const real = dtoToAsset(res.data as AssetItemDto);
        set((s) => ({ items: s.items.map((i) => i.id === tempId ? real : i) }));
      } else {
        // Server rejected → rollback
        set((s) => ({ items: s.items.filter((i) => i.id !== tempId) }));
      }
    }).catch(() => {
      // Network error → rollback
      set((s) => ({ items: s.items.filter((i) => i.id !== tempId) }));
    });

    return item;
  },

  addAssetsBatch: async (inputs) => {
    const res = await assetApi.createAssetsBatch(
      inputs.map((input) => ({
        name: input.name, type: input.type,
        width: input.width, height: input.height,
        description: input.description, tags: input.tags,
        extra_data: input.metadata, folder_id: toIntId(input.folderId || ""), space_key: input.spaceKey || "personal",
      })),
    );
    if (res.code === 200 && res.data) {
      const newItems = res.data.map((d: AssetItemDto) => dtoToAsset(d));
      set((s) => ({ items: [...newItems, ...s.items] }));
      return newItems;
    }
    return [];
  },

  updateAsset: async (id, patch) => {
    set((s) => ({
      items: s.items.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
      ),
    }));
    const intId = toIntId(id);
    if (!intId) return;
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.type !== undefined) body.type = patch.type;
    if (patch.folderId !== undefined) body.folder_id = toIntId(patch.folderId);
    if (Object.keys(body).length > 0) {
      await assetApi.updateAsset(intId, body).catch(() => {});
    }
  },

  removeAsset: async (id) => {
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    const intId = toIntId(id);
    if (intId) await assetApi.deleteAsset(intId).catch(() => {});
  },

  updateAssetsBatch: async (ids, updates) => {
    set((s) => ({
      items: s.items.map((item) =>
        ids.includes(item.id) ? { ...item, ...updates, updatedAt: Date.now() } : item,
      ),
    }));
    const intIds = ids.map(toIntId).filter((n): n is number => n != null);
    if (intIds.length > 0) {
      const body: Record<string, unknown> = {};
      if ("folderId" in updates) body.folder_id = toIntId(String(updates.folderId || "")) ?? null;
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
    const folder: AssetFolder = { id: tempId, name, spaceKey, parentId, createdAt: Date.now() };
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
    // Collect the full subtree (folder + descendant subfolders) for optimistic removal.
    const subtree = new Set<number>([id]);
    const stack = [id];
    const { folders: rootFolders } = get();
    const byParent = new Map<number | undefined, number[]>();
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
    set((s) => ({
      folders: s.folders.filter((f) => !subtree.has(f.id)),
      // 整个子树内的资产一并移除
      items: s.items.filter((item) => !item.folderId || !subtree.has(item.folderId)),
    }));
    const intId = toIntId(id);
    if (intId) await assetApi.deleteFolder(intId).catch(() => {});
  },

  // --- Queries ---

  getFiltered: (category, search, folderId, spaceKey) => {
    const { items } = get();
    let result = items;

    if (spaceKey) {
      result = result.filter((item) => item.spaceKey === spaceKey);
    }

    if (folderId) {
      result = result.filter((item) => item.folderId === folderId);
    } else if (folderId === null) {
      // Root view — only assets directly under root (no folder)
      result = result.filter((item) => !item.folderId);
    }

    if (category !== "all") {
      result = result.filter((item) => item.type === category);
    }

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return result;
  },

  getFoldersBySpace: (spaceKey) => {
    return get().folders.filter((f) => f.spaceKey === spaceKey);
  },

  getChildFolders: (spaceKey, parentId) => {
    return get().folders.filter(
      (f) => f.spaceKey === spaceKey && (f.parentId || undefined) === (parentId || undefined),
    );
  },
}));
