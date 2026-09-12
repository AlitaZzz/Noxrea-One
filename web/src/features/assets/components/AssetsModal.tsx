/**
 * 资产库主弹窗，资产模块的容器与编排层。
 * 组合左侧空间 / 文件夹树、顶部分类页签与工具条、主体资产网格，
 * 统一处理分页加载、搜索筛选、批量选择与批量删除 / 移动 / 改类型、
 * 文件夹增删，以及「插入画布」（经 createAssetNode 转成画布节点）。
 */
"use client";

import { DatabaseOutlined, FolderOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Input, Select, Tooltip } from "antd";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import AppModal from "@/components/ui/AppModal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { AssetsIcon } from "@/components/ui/icons/canvas/AssetsIcon";
import { createAssetNode } from "@/features/assets/add-asset";
import { useAssetLibrary } from "@/features/assets/hooks/use-asset-library";
import { computeRecursiveFolderCounts, useAssetsStore } from "@/features/assets/store";
import type { AssetFolder, AssetItem, AssetScope, AssetType, CreateAssetInput } from "@/features/assets/types";
import { findFreePosition, getViewportCenter, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { ASSET_CATEGORIES } from "@/lib/constants";

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

  const gridRef = useRef<HTMLDivElement>(null);

  const [activeScope, setActiveScope] = useState<AssetScope>("personal");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const getUncategorizedFolder = useAssetsStore((s) => s.getUncategorizedFolder);
  const uncategorizedFolder = getUncategorizedFolder(activeScope);
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

  // 单选页签映射为共用 Hook 的多类型筛选；空数组表示"全部"。
  const categories = useMemo<AssetType[]>(
    () => (category === "all" ? [] : [category]),
    [category],
  );

  // 与画布抽屉共用同一条查询链路，弹窗只负责展示和批量操作。
  const {
    items,
    loading,
    loadingMore,
    loadError,
    hasMore,
    reload,
    loadMore: fetchNextPage,
    setItems,
    setTotalCount,
  } = useAssetLibrary({
    enabled: open,
    scope: activeScope,
    folderId: activeFolderId,
    search,
    categories,
  });

  const handleToggleSelect = useCallback((asset: AssetItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, []);

  // Selection
  const allSelected = items.length > 0 && items.every((a) => selectedIds.has(a.id));

  const handleSelectAll = useCallback(() => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map((a) => a.id)));
  }, [allSelected, items]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteAsset({ id: String(selectedIds.size), name: `${selectedIds.size} ${t("asset.count")}`, type: "other", mediaType: "", width: 0, height: 0, description: "", createdAt: 0, updatedAt: 0, tags: [], extraData: {}, scope: "personal" } as AssetItem);
  }, [selectedIds, t]);

  const handleBatchDeleteConfirm = useCallback(async () => {
    const ids = [...selectedIds];
    // 逐个等待结果：只有真正删除成功的才从列表移除（失败原因由 store 提示）
    const results = await Promise.all(
      ids.map((id) => {
        const item = items.find((i) => i.id === id);
        return removeAsset(id, item?.sourceUrl);
      }),
    );
    const removed = new Set(ids.filter((_, i) => results[i]));
    if (removed.size > 0) {
      setItems((prev) => prev.filter((i) => !removed.has(i.id)));
      setTotalCount((c) => Math.max(0, c - removed.size));
    }
    // 只保留删除失败的项，便于直接重试
    setSelectedIds(new Set(ids.filter((_, i) => !results[i])));
    setDeleteAsset(null);
  }, [selectedIds, removeAsset, items, setItems, setTotalCount]);

  const handleBatchMove = useCallback(async (folderId: string) => {
    const ok = await updateAssetsBatch([...selectedIds], { folderId });
    // 失败保留选中，用户可直接重试
    if (!ok) return;
    setSelectedIds(new Set());
    setBatchMoveOpen(false);
    // 刷新当前视图以立即反映移动结果
    reload();
  }, [selectedIds, updateAssetsBatch, reload]);

  const handleBatchType = useCallback(async (type: AssetType) => {
    const ids = [...selectedIds];
    const ok = await updateAssetsBatch(ids, { type });
    // 失败保留选中，用户可直接重试
    if (!ok) return;
    setSelectedIds(new Set());
    setBatchTypeOpen(false);
    // 类型变了，当前筛选可能已不适用，重新拉取比本地改字段更可靠
    if (activeFolderId !== null || category !== "all" || search.trim()) {
      reload();
    } else {
      setItems((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, type } : i)));
    }
  }, [selectedIds, updateAssetsBatch, activeFolderId, category, search, reload, setItems]);

  // Current folder depth (max 2 levels allowed)
  const currentFolderDepth = useMemo(() => {
    if (!activeFolderId) return 0;
    let depth = 0;
    let id: string | undefined = activeFolderId;
    while (id) {
      depth++;
      const f = folders.find((x) => x.id === id);
      id = f?.parentId || undefined;
    }
    return depth;
  }, [activeFolderId, folders]);
  const currentFolder = activeFolderId
    ? folders.find((folder) => folder.id === activeFolderId)
    : undefined;
  const canCreateFolder = currentFolderDepth < 2 && currentFolder?.kind !== "uncategorized";

  // 与抽屉共用同一套递归计数逻辑，避免目录数量展示不一致。
  const folderCounts = useMemo(() => computeRecursiveFolderCounts(folders), [folders]);

  const gridFolders = useMemo<AssetFolder[]>(() => {
    const childFolders = getChildFolders(activeScope, activeFolderId ?? undefined);
    if (activeFolderId !== null) return childFolders;
    return uncategorizedFolder
      ? [{ ...uncategorizedFolder, name: t("asset.uncategorized") }, ...childFolders]
      : childFolders;
  }, [activeFolderId, getChildFolders, uncategorizedFolder, activeScope, t]);


  // --- Handlers ---

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    const node = createAssetNode(asset, getViewportCenter(), findFreePosition);
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
      const result = await addAssetsBatch(inputs);
      if (result.items.length > 0) {
        reload();
        gridRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
      // 把结果交回上传弹窗，由其决定关闭与提示；失败时不再静默关闭。
      return result;
    },
    [addAssetsBatch, reload],
  );

  const handleCreateFolder = useCallback(
    async (name: string): Promise<boolean> => {
      const parentId = activeFolderId ?? undefined;
      const result = await addFolder(name, activeScope, parentId);
      return result !== null;
    },
    [addFolder, activeScope, activeFolderId],
  );

  const handleRename = useCallback((asset: AssetItem) => { setRenamingId(asset.id); setRenameValue(asset.name); }, []);
  const handleRenameConfirm = useCallback(async () => {
    const id = renamingId;
    const name = renameValue.trim();
    setRenamingId(null);
    setRenameValue("");
    if (!id || !name) return;
    // 成功后同步本地列表：此前只发请求，网格里仍是旧名称
    if (await updateAsset(id, { name })) {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)));
    }
  }, [renamingId, renameValue, updateAsset, setItems]);

  const handleDelete = useCallback((asset: AssetItem) => { setDeleteAsset(asset); }, []);
  const handleDeleteFolder = useCallback((folder: AssetFolder) => { setDeleteFolder(folder); }, []);

  const handleDeleteFolderConfirm = useCallback(async () => {
    if (!deleteFolder) return;
    const deletedId = deleteFolder.id;
    const removed = await removeFolder(deletedId);
    // 只有删除成功才把用户切回根目录；失败原因由 store 统一通知
    if (removed && activeFolderId) {
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

  const handleSelectScope = useCallback((scope: AssetScope) => { setActiveScope(scope); setActiveFolderId(null); setSelectedIds(new Set()); }, []);
  const handleSelectFolder = useCallback((id: string | null) => { setActiveFolderId(id); setSelectedIds(new Set()); }, []);

  const spaceLabels = useMemo(
    () => [
      { key: "personal" as AssetScope, label: t("asset.spacePersonal"), icon: <UserOutlined /> },
    ],
    [t, lang],
  );

  // Breadcrumb data
  const breadCrumb = useMemo((): AssetFolder[] => {
    if (!activeFolderId) return [];
    const crumbs: AssetFolder[] = [];
    let cur: string | undefined = activeFolderId;
    while (cur) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      crumbs.unshift(f);
      cur = f.parentId || undefined;
    }
    return crumbs;
  }, [activeFolderId, folders, activeScope, t, lang]);

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
        className="asset-library-modal select-none"
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
              scopes={spaceLabels}
              activeScope={activeScope}
              activeFolderId={activeFolderId}
              onSelectScope={handleSelectScope}
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
                        {f.kind === "uncategorized" ? t("asset.uncategorized") : f.name}
                      </span>
                    ) : (
                      <button
                        onClick={() => setActiveFolderId(f.id)}
                        className="text-sm px-2 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
                        style={{ color: "var(--canvas-text-dim)" }}
                      >
                        {f.kind === "uncategorized" ? t("asset.uncategorized") : f.name}
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
              onBatchType={() => { setBatchTypeValue(undefined); setBatchTypeOpen(true); }}
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
                folders={activeFolderId === null && category === "all" && !search.trim() ? gridFolders : undefined}
                folderCounts={folderCounts}
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
                onRetry={reload}
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
              <AppButton onClick={() => setRenamingId(null)}>{t("common.cancel")}</AppButton>
              <AppButton variant="primary" onClick={handleRenameConfirm} disabled={!renameValue.trim()}>{t("common.save")}</AppButton>
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
          onOk={async () => {
            if (!deleteAsset) return;
            if (selectedIds.size > 0) {
              await handleBatchDeleteConfirm();
              return;
            }
            // 只有删除成功才从列表移除；失败原因由 store 统一通知
            const removed = await removeAsset(deleteAsset.id, deleteAsset.sourceUrl);
            if (removed) {
              setItems((prev) => prev.filter((i) => i.id !== deleteAsset.id));
              setTotalCount((c) => Math.max(0, c - 1));
            }
            setDeleteAsset(null);
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
              <AppButton onClick={() => setBatchMoveOpen(false)}>{t("common.cancel")}</AppButton>
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
              onClick={() => uncategorizedFolder && handleBatchMove(uncategorizedFolder.id)}
              className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left"
              style={{ color: "var(--canvas-text)" }}
            >
              <FolderOutlined style={{ color: "var(--canvas-text-muted)" }} />
              {t("asset.uncategorized")}
            </button>
            {(() => {
              const personalFolders = folders.filter((f) => f.scope === "personal" && f.kind === "normal");
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
              <AppButton onClick={() => setBatchTypeOpen(false)}>{t("common.cancel")}</AppButton>
              <Tooltip title={!batchTypeValue ? t("asset.typeTip") : ""}>
                <span>
                  <AppButton variant="primary" disabled={!batchTypeValue} onClick={() => handleBatchType(batchTypeValue!)}>{t("common.save")}</AppButton>
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
