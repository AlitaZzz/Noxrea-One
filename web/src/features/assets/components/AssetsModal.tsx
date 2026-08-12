/**
 * 资产库主弹窗，资产模块的容器与编排层。
 * 组合左侧空间 / 文件夹树、顶部分类页签与工具条、主体资产网格，
 * 统一处理分页加载、搜索筛选、批量选择与批量删除 / 移动 / 改类型、
 * 文件夹增删，以及「插入画布」（经 createAssetNode 转成画布节点）。
 */
"use client";

import { DatabaseOutlined, FolderOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Input, Select, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AppModal from "@/components/ui/AppModal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { AssetsIcon } from "@/components/ui/icons/canvas/AssetsIcon";
import ModalButton from "@/components/ui/ModalButton";
import { createAssetNode } from "@/features/assets/add-asset";
import { assetApi } from "@/features/assets/api";
import { ASSET_CATEGORIES, UNCATEGORIZED_FOLDER_ID } from "@/lib/constants";
import type { AssetFolder, AssetItem, AssetType, CreateAssetInput } from "@/features/assets/types";
import { ASSET_PAGE_SIZE, fetchAssetPage, useAssetsStore } from "@/features/assets/store";
import { findFreePosition, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

import AssetCategoryTabs from "./AssetCategoryTabs";
import AssetCreateDialog from "./AssetCreateDialog";
import AssetGrid from "./AssetGrid";
import AssetNav from "./AssetNav";
import AssetToolbar from "./AssetToolbar";
import CreateFolderDialog from "./CreateFolderDialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AssetsModal({ open, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { notification: notif } = App.useApp();
  const folders = useAssetsStore((s) => s.folders);
  const addAssetsBatch = useAssetsStore((s) => s.addAssetsBatch);
  const addFolder = useAssetsStore((s) => s.addFolder);
  const updateAsset = useAssetsStore((s) => s.updateAsset);
  const removeAsset = useAssetsStore((s) => s.removeAsset);
  const removeFolder = useAssetsStore((s) => s.removeFolder);
  const updateAssetsBatch = useAssetsStore((s) => s.updateAssetsBatch);
  const getChildFolders = useAssetsStore((s) => s.getChildFolders);

  // Independent local state — not shared with sidebar
  const [items, setItems] = useState<AssetItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const versionRef = useRef(0);

  const [activeSpace, setActiveSpace] = useState("personal");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);
  const bumpUncategorizedCount = useCallback((delta: number) => {
    setUncategorizedCount((c) => Math.max(0, c + delta));
  }, []);
  const [category, setCategory] = useState<AssetType | "all">("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirm state
  const [deleteAsset, setDeleteAsset] = useState<AssetItem | null>(null);

  // Delete folder confirm state
  const [deleteFolder, setDeleteFolder] = useState<AssetFolder | null>(null);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchTypeOpen, setBatchTypeOpen] = useState(false);
  const [batchTypeValue, setBatchTypeValue] = useState<AssetType | undefined>(undefined);
  // 每次打开「修改类型」弹窗时重置，默认什么都不选
  useEffect(() => {
    if (batchTypeOpen) setBatchTypeValue(undefined);
  }, [batchTypeOpen]);

  const handleToggleSelect = useCallback((asset: AssetItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, []);

  // --- Data fetching ---

  const fetchAndReplace = useCallback(async (filters: { category: AssetType | "all"; search: string; folderId: string | null; spaceKey: string }) => {
    const v = ++versionRef.current;
    setItems([]);
    setTotalCount(0);
    setLoading(true);
    setLoadError(false);
    try {
      const result = await fetchAssetPage(
        { category: filters.category, search: filters.search, folderId: filters.folderId, spaceKey: filters.spaceKey },
        0,
      );
      if (v !== versionRef.current) return;
      setItems(result.items);
      setTotalCount(result.total);
      setLoading(false);
    } catch {
      if (v !== versionRef.current) return;
      setLoadError(true);
      setLoading(false);
    }
  }, []);

  const fetchNextPage = useCallback(async () => {
    const v = ++versionRef.current;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const folderId = activeFolderId === UNCATEGORIZED_FOLDER_ID ? null : activeFolderId;
      if (activeFolderId === null) return; // 根视图不展示散落资产，无需翻页
      const result = await fetchAssetPage(
        { category, search, folderId, spaceKey: activeSpace },
        items.length,
      );
      if (v !== versionRef.current) return;
      setItems((prev) => [...prev, ...result.items]);
      setTotalCount(result.total);
      setLoadingMore(false);
    } catch {
      if (v !== versionRef.current) return;
      setLoadError(true);
      setLoadingMore(false);
    }
  }, [category, search, activeFolderId, activeSpace, items.length]);

  // Fetch when modal opens or filters change
  useEffect(() => {
    if (!open) { setLoadError(false); setLoading(false); return; }
    // 根视图：只展示文件夹（含虚拟「未分类」），不拉取散落资产
    if (activeFolderId === null) {
      setItems([]);
      setTotalCount(0);
      setLoading(false);
      setLoadError(false);
      return;
    }
    const folderId = activeFolderId === UNCATEGORIZED_FOLDER_ID ? null : activeFolderId;
    fetchAndReplace({ category, search, folderId, spaceKey: activeSpace });
  }, [open, category, search, activeFolderId, activeSpace, fetchAndReplace]);

  // 拉取「未分类」资产数量（仅根视图需要）
  useEffect(() => {
    if (activeFolderId !== null) { setUncategorizedCount(0); return; }
    if (!open) return;
    let cancelled = false;
    assetApi.listAssets({ spaceKey: activeSpace, folderId: -1, skip: 0, limit: 1 })
      .then((r) => { if (!cancelled) setUncategorizedCount(r.data?.total ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeFolderId, activeSpace, open]);

  const hasMore = items.length < totalCount;

  // Selection
  const allSelected = items.length > 0 && items.every((a) => selectedIds.has(a.id));

  const handleSelectAll = useCallback(() => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map((a) => a.id)));
  }, [allSelected, items]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteAsset({ id: String(selectedIds.size), name: `${selectedIds.size} ${t("asset.count")}`, type: "other", mediaType: "", width: 0, height: 0, description: "", createdAt: 0, updatedAt: 0, tags: [], metadata: {}, spaceKey: "personal" } as AssetItem);
  }, [selectedIds, t]);

  const handleBatchDeleteConfirm = useCallback(() => {
    for (const id of selectedIds) {
      const item = items.find((i) => i.id === id);
      if (item?.folderId == null) bumpUncategorizedCount(-1);
      else if (item?.folderId) useAssetsStore.getState().bumpFolderCount(item.folderId, -1);
      removeAsset(id, item?.metadata?.sourceUrl);
    }
    setItems((prev) => prev.filter((i) => !selectedIds.has(i.id)));
    setTotalCount((c) => Math.max(0, c - selectedIds.size));
    setSelectedIds(new Set());
    setDeleteAsset(null);
  }, [selectedIds, removeAsset, items, bumpUncategorizedCount]);

  const handleBatchMove = useCallback((folderId: string) => {
    const targetIsUncategorized = folderId === UNCATEGORIZED_FOLDER_ID;
    const realFolderId = targetIsUncategorized ? undefined : folderId || undefined;
    for (const id of selectedIds) {
      const item = items.find((i) => i.id === id);
      if (!item) continue;
      const wasUncategorized = item.folderId == null;
      if (wasUncategorized && !targetIsUncategorized) bumpUncategorizedCount(-1);
      if (!wasUncategorized && targetIsUncategorized) bumpUncategorizedCount(1);
      if (item.folderId) useAssetsStore.getState().bumpFolderCount(item.folderId, -1);
      if (folderId && !targetIsUncategorized) useAssetsStore.getState().bumpFolderCount(folderId, 1);
    }
    updateAssetsBatch([...selectedIds], { folderId: realFolderId });
    setSelectedIds(new Set());
    setBatchMoveOpen(false);
    // 刷新当前视图以立即反映移动结果
    if (activeFolderId !== null) {
      const fId = activeFolderId === UNCATEGORIZED_FOLDER_ID ? null : activeFolderId;
      fetchAndReplace({ category, search, folderId: fId, spaceKey: activeSpace });
    }
  }, [selectedIds, updateAssetsBatch, items, activeFolderId, activeSpace, category, search, bumpUncategorizedCount, fetchAndReplace]);

  const handleBatchType = useCallback((type: AssetType) => {
    updateAssetsBatch([...selectedIds], { type });
    setSelectedIds(new Set());
    setBatchTypeOpen(false);
  }, [selectedIds, updateAssetsBatch]);

  // Current folder depth (max 2 levels allowed)
  const currentFolderDepth = useMemo(() => {
    if (!activeFolderId || activeFolderId === UNCATEGORIZED_FOLDER_ID) return 0;
    let depth = 0;
    let id: string | undefined = activeFolderId;
    while (id) {
      depth++;
      const f = folders.find((x) => x.id === id);
      id = f?.parentId || undefined;
    }
    return depth;
  }, [activeFolderId, folders]);
  const canCreateFolder = currentFolderDepth < 2 && activeFolderId !== UNCATEGORIZED_FOLDER_ID;

  // Folder counts from server (lazy-load safe)
  const folderCounts = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const f of folders) totals[f.id] = f.count || 0;
    const cache: Record<string, number> = {};
    const getRecursive = (folderId: string): number => {
      if (cache[folderId] !== undefined) return cache[folderId];
      let total = totals[folderId] || 0;
      for (const child of folders.filter((f2) => f2.parentId === folderId)) {
        total += getRecursive(child.id);
      }
      cache[folderId] = total;
      return total;
    };
    const counts: Record<string, number> = {};
    for (const f of folders) counts[f.id] = getRecursive(f.id);
    return counts;
  }, [folders]);

  // 根视图额外注入虚拟「未分类」文件夹（folder_id 为 NULL 的资产集合）
  const gridFolders = useMemo<AssetFolder[]>(() => {
    const childFolders = getChildFolders(activeSpace, activeFolderId ?? undefined);
    if (activeFolderId !== null) return childFolders;
    return [
      ...childFolders,
      {
        id: UNCATEGORIZED_FOLDER_ID,
        name: t("asset.uncategorized"),
        spaceKey: activeSpace,
        parentId: undefined,
        createdAt: 0,
        count: uncategorizedCount,
      },
    ];
  }, [activeFolderId, getChildFolders, uncategorizedCount, activeSpace, t, lang, folders]);

  const displayFolderCounts = useMemo(
    () => ({ ...folderCounts, [UNCATEGORIZED_FOLDER_ID]: uncategorizedCount }),
    [folderCounts, uncategorizedCount],
  );

  // --- Handlers ---

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    const node = createAssetNode(asset, findFreePosition);
    if (node) useCanvasStore.getState().addNodes([node]);
    notif.success({
      title: t("asset.added"),
      description: asset.name,
      placement: "bottomRight",
      duration: 3,
    });
  }, [notif, t]);

  const handleCreateAssets = useCallback(
    async (inputs: CreateAssetInput[]) => {
      const created = await addAssetsBatch(inputs);
      if (created.length > 0) {
        for (const asset of created) {
          if (asset.folderId == null) bumpUncategorizedCount(1);
          else useAssetsStore.getState().bumpFolderCount(asset.folderId, 1);
        }
        // 根视图不展示散落资产，跳过刷新以免把「未分类」资产直接显示到根目录
        if (activeFolderId !== null) {
          const folderId = activeFolderId === UNCATEGORIZED_FOLDER_ID ? null : activeFolderId;
          fetchAndReplace({ category, search, folderId, spaceKey: activeSpace });
        }
        gridRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [addAssetsBatch, category, search, activeFolderId, activeSpace, fetchAndReplace, bumpUncategorizedCount],
  );

  const handleCreateFolder = useCallback(
    async (name: string): Promise<boolean> => {
      const parentId = activeFolderId === UNCATEGORIZED_FOLDER_ID ? undefined : activeFolderId ?? undefined;
      const result = await addFolder(name, activeSpace, parentId);
      return result !== null;
    },
    [addFolder, activeSpace, activeFolderId],
  );

  const handleRename = useCallback((asset: AssetItem) => { setRenamingId(asset.id); setRenameValue(asset.name); }, []);
  const handleRenameConfirm = useCallback(() => {
    if (renamingId && renameValue.trim()) updateAsset(renamingId, { name: renameValue.trim() });
    setRenamingId(null);
    setRenameValue("");
  }, [renamingId, renameValue, updateAsset]);

  const handleDelete = useCallback((asset: AssetItem) => { setDeleteAsset(asset); }, []);
  const handleDeleteFolder = useCallback((folder: AssetFolder) => { setDeleteFolder(folder); }, []);

  const handleDeleteFolderConfirm = useCallback(() => {
    if (!deleteFolder) return;
    const deletedId = deleteFolder.id;
    removeFolder(deletedId);
    if (activeFolderId) {
      let cur: string | null = activeFolderId;
      let within = false;
      while (cur) {
        if (cur === deletedId) { within = true; break; }
        cur = folders.find((f) => f.id === cur)?.parentId || null;
      }
      if (within) setActiveFolderId(null);
    }
    setSelectedIds(new Set());
    setDeleteFolder(null);
  }, [deleteFolder, removeFolder, activeFolderId, folders]);

  const handleSelectSpace = useCallback((key: string) => { setActiveSpace(key); setActiveFolderId(null); setSelectedIds(new Set()); }, []);
  const handleSelectFolder = useCallback((id: string | null) => { setActiveFolderId(id); setSelectedIds(new Set()); }, []);

  const spaceLabels = useMemo(
    () => [
      { key: "personal", label: t("asset.spacePersonal"), icon: <UserOutlined /> },
      { key: "reusable", label: t("asset.spaceReusable"), icon: <DatabaseOutlined /> },
    ],
    [t, lang],
  );

  // Breadcrumb data
  const breadCrumb = useMemo((): AssetFolder[] => {
    if (!activeFolderId) return [];
    if (activeFolderId === UNCATEGORIZED_FOLDER_ID) {
      return [{
        id: UNCATEGORIZED_FOLDER_ID,
        name: t("asset.uncategorized"),
        spaceKey: activeSpace,
        parentId: undefined,
        createdAt: 0,
        count: 0,
      }];
    }
    const crumbs: AssetFolder[] = [];
    let cur: string | undefined = activeFolderId;
    while (cur) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      crumbs.unshift(f);
      cur = f.parentId || undefined;
    }
    return crumbs;
  }, [activeFolderId, folders, activeSpace, t, lang]);

  return (
    <>
      <AppModal
        title={
          <div className="flex items-center gap-2">
            <AssetsIcon style={{ color: "var(--canvas-text-secondary)", fontSize: 18 }} />
            <span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.title")}</span>
          </div>
        }
        open={open}
        onCancel={onClose}
        footer={null}
        width="90vw"
        centered
        destroyOnHidden
        className="asset-library-modal"
        styles={{
            header: { background: "var(--canvas-bg)" },
          body: { background: "var(--canvas-bg)", padding: 0, maxHeight: "calc(100vh - 140px)", overflow: "hidden" },
        }}
        style={{ maxWidth: 1200 }}
        closeIcon={<span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>}
      >
        <style>{`
          .menu-popover-item:not(.menu-item-disabled):hover { background: var(--canvas-bg-hover) !important; }
          .asset-library-modal .ant-input:hover,
          .asset-library-modal .ant-input:focus,
          .asset-library-modal .ant-input-focused,
          .asset-library-modal .ant-input-affix-wrapper:hover,
          .asset-library-modal .ant-input-affix-wrapper:focus,
          .asset-library-modal .ant-input-affix-wrapper-focused,
          .asset-library-modal .ant-select-selector:hover,
          .asset-library-modal .ant-select-focused .ant-select-selector {
            border-color: var(--canvas-border) !important;
            box-shadow: none !important;
          }
          .asset-library-modal .ant-select.ant-select { height: 36px !important; }
          .asset-library-modal .ant-select-selector.ant-select-selector {
            background: var(--canvas-bg) !important;
            border-color: var(--canvas-border) !important;
            color: var(--canvas-text) !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            height: 36px !important;
          }
          .ant-modal-confirm .ant-modal-mask {
            background: rgba(0,0,0,0.6) !important;
          }
        `}</style>
        <div className="flex" style={{ height: "calc(85vh - 160px)", minHeight: 400 }}>
          {/* Left sidebar */}
          <div
            className="flex flex-col py-4 border-r shrink-0"
            style={{ borderColor: "var(--canvas-border)", paddingLeft: 0, paddingRight: 16 }}
          >
            <AssetNav
              spaces={spaceLabels}
              activeSpace={activeSpace}
              activeFolderId={activeFolderId}
              onSelectSpace={handleSelectSpace}
              onSelectFolder={handleSelectFolder}
              folders={folders}
              folderCounts={folderCounts}
              onDeleteFolder={handleDeleteFolder}
            />
          </div>

          {/* Right main content */}
          <div className="flex-1 flex flex-col py-4 pr-4 pl-4 min-w-0">
            {/* Breadcrumb — placed above toolbar, always visible */}
            <div className="flex items-center gap-1 pb-2 flex-shrink-0">
              {/* 根：个人资产库（根视图为当前项不可点，进入文件夹后可点击返回） */}
              {activeFolderId === null ? (
                <span className="text-sm px-2 py-0.5 whitespace-nowrap cursor-default" style={{ color: "var(--canvas-text)" }}>
                  {t("asset.spacePersonal")}
                </span>
              ) : (
                <button
                  onClick={() => setActiveFolderId(null)}
                  className="text-sm px-2 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
                  style={{ color: "var(--canvas-text-dim)" }}
                >
                  {t("asset.spacePersonal")}
                </button>
              )}
              {breadCrumb.map((f) => {
                const isLast = f.id === activeFolderId;
                return (
                  <span key={f.id} className="flex items-center gap-1">
                    <span style={{ color: "var(--canvas-text-dim)" }}>/</span>
                    {isLast ? (
                      <span className="text-sm px-2 py-0.5 whitespace-nowrap cursor-default" style={{ color: "var(--canvas-text)" }}>
                        {f.name}
                      </span>
                    ) : (
                      <button
                        onClick={() => setActiveFolderId(f.id)}
                        className="text-sm px-2 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
                        style={{ color: "var(--canvas-text-dim)" }}
                      >
                        {f.name}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>

            {/* Toolbar */}
            <AssetToolbar
              search={search}
              onSearchChange={setSearch}
              selectedCount={selectedIds.size}
              allSelected={allSelected}
              onSelectAll={handleSelectAll}
              onBatchDelete={handleBatchDelete}
              onBatchMove={() => setBatchMoveOpen(true)}
              onBatchType={() => setBatchTypeOpen(true)}
              onUpload={() => setCreateOpen(true)}
              onCreateFolder={() => setFolderCreateOpen(true)}
              canCreateFolder={canCreateFolder}
            />

            {/* Category tabs */}
            <AssetCategoryTabs active={category} onChange={setCategory} />

            {/* Grid */}
            <div className="flex-1 overflow-auto min-h-0" style={{ paddingRight: 8, scrollbarGutter: "stable" }} ref={gridRef}>
              <AssetGrid
                assets={items}
                folders={gridFolders}
                folderCounts={displayFolderCounts}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
                onInsertCanvas={handleInsertCanvas}
                onRename={handleRename}
                onDelete={handleDelete}
                onEnterFolder={(folder) => setActiveFolderId(folder.id)}
                onDeleteFolder={handleDeleteFolder}
                loading={loading}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={fetchNextPage}
                loadError={loadError}
                onRetry={fetchNextPage}
              />
            </div>
          </div>
        </div>

        {/* Rename modal */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.rename")}</span>}
          open={!!renamingId}
          onCancel={() => setRenamingId(null)}
          centered
          destroyOnHidden
          width={400}
          className="rename-modal"
          footer={
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => setRenamingId(null)}>{t("common.cancel")}</ModalButton>
              <ModalButton variant="primary" onClick={handleRenameConfirm} disabled={!renameValue.trim()}>{t("common.save")}</ModalButton>
            </div>
          }
          styles={{
                header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "20px 24px 8px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
          closeIcon={<span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>}
        >
          <style>{`
            .rename-modal .ant-input:hover,
            .rename-modal .ant-input:focus,
            .rename-modal .ant-input-affix-wrapper:hover,
            .rename-modal .ant-input-affix-wrapper:focus {
              border-color: var(--canvas-border) !important;
              box-shadow: none !important;
            }
            .rename-modal .rename-save-btn:not(:disabled):hover {
              background: var(--canvas-bg-hover) !important;
            }
          `}</style>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value.slice(0, 100))}
            onPressEnter={handleRenameConfirm}
            maxLength={100}
            showCount
            style={{ background: "var(--canvas-bg-elevated)", borderColor: "var(--canvas-border)", color: "var(--canvas-text)" }}
          />
        </AppModal>

        {/* Delete confirm */}
        <ConfirmModal
          open={!!deleteAsset}
          title={t("asset.delete")}
          content={deleteAsset?.name || ""}
          onOk={() => {
            if (!deleteAsset) return;
            if (selectedIds.size > 0) {
              handleBatchDeleteConfirm();
            } else {
              removeAsset(deleteAsset.id, deleteAsset.metadata?.sourceUrl);
              if (deleteAsset.folderId == null) bumpUncategorizedCount(-1);
              else if (deleteAsset.folderId) useAssetsStore.getState().bumpFolderCount(deleteAsset.folderId, -1);
              setItems((prev) => prev.filter((i) => i.id !== deleteAsset.id));
              setTotalCount((c) => Math.max(0, c - 1));
              setDeleteAsset(null);
            }
          }}
          onCancel={() => { setDeleteAsset(null); setSelectedIds(new Set()); }}
        />

        {/* Delete folder confirm */}
        <ConfirmModal
          open={!!deleteFolder}
          title={t("asset.folder.delete")}
          content={`${deleteFolder?.name || ""} — ${t("asset.folder.deleteWarn")}`}
          onOk={handleDeleteFolderConfirm}
          onCancel={() => { setDeleteFolder(null); setSelectedIds(new Set()); }}
        />

        {/* Batch move modal */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.moveTo")}</span>}
          open={batchMoveOpen}
          onCancel={() => setBatchMoveOpen(false)}
          centered
          destroyOnHidden
          width={360}
          footer={
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => setBatchMoveOpen(false)}>{t("common.cancel")}</ModalButton>
            </div>
          }
          styles={{
                header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "12px 24px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
        >
          <div className="flex flex-col gap-1.5 max-h-60 overflow-auto">
            <button
              onClick={() => handleBatchMove("")}
              className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left"
              style={{ color: "var(--canvas-text)" }}
            >
              <FolderOutlined style={{ color: "var(--canvas-text-muted)" }} />
              {t("asset.spacePersonal")}
            </button>
            <button
              onClick={() => handleBatchMove(UNCATEGORIZED_FOLDER_ID)}
              className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left"
              style={{ color: "var(--canvas-text)" }}
            >
              <FolderOutlined style={{ color: "var(--canvas-text-muted)" }} />
              {t("asset.uncategorized")}
            </button>
            {(() => {
              const personalFolders = folders.filter((f) => f.spaceKey === "personal");
              const buildTree = (parentId: string | undefined, depth: number): React.ReactNode[] => {
                const children = personalFolders.filter((f) => (f.parentId || undefined) === parentId);
                return children.flatMap((f) => [
                  <button
                    key={f.id}
                    onClick={() => handleBatchMove(f.id)}
                    className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left"
                    style={{ color: "var(--canvas-text)", paddingLeft: 24 + depth * 16 }}
                  >
                    <FolderOutlined style={{ color: "var(--canvas-text-muted)" }} />
                    {f.name}
                  </button>,
                  ...buildTree(f.id, depth + 1),
                ]);
              };
              return buildTree(undefined, 0);
            })()}
          </div>
        </AppModal>

        {/* Batch type modal */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.changeType")}</span>}
          open={batchTypeOpen}
          onCancel={() => setBatchTypeOpen(false)}
          centered
          destroyOnHidden
          width={360}
          footer={
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => setBatchTypeOpen(false)}>{t("common.cancel")}</ModalButton>
              <Tooltip title={!batchTypeValue ? t("asset.typeTip") : ""}>
                <span>
                  <ModalButton variant="primary" disabled={!batchTypeValue} onClick={() => handleBatchType(batchTypeValue!)}>{t("common.save")}</ModalButton>
                </span>
              </Tooltip>
            </div>
          }
          styles={{
                header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "12px 24px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
        >
          <Select
            value={batchTypeValue}
            onChange={(v) => setBatchTypeValue(v)}
            getPopupContainer={(t) => t.parentElement || document.body}
            style={{ width: "100%" }}
            placeholder={t("asset.typePlaceholder")}
            allowClear
            options={ASSET_CATEGORIES.filter((c) => c.key !== "all").map((cat) => ({ value: cat.key, label: t(cat.labelKey) }))}
          />
        </AppModal>

        {/* Upload dialog */}
        <AssetCreateDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreateAssets}
          folders={folders}
        />

        {/* Create folder dialog */}
        <CreateFolderDialog
          open={folderCreateOpen}
          onClose={() => setFolderCreateOpen(false)}
          onCreate={handleCreateFolder}
        />
      </AppModal>
    </>
  );
}
