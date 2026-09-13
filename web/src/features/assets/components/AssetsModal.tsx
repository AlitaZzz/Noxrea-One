/**
 * 资产库主弹窗，资产模块的容器与编排层。
 * 组合左侧空间 / 文件夹树、顶部分类页签与工具条、主体资产网格，
 * 统一处理分页加载、搜索筛选、批量选择与批量删除 / 移动 / 改类型、
 * 文件夹增删改，以及「插入画布」（经 createAssetNode 转成画布节点）。
 */
"use client";

import { FolderOutlined, UserOutlined } from "@ant-design/icons";
import { App, Input, Select, Tooltip } from "antd";
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

import AssetCreateDialog from "./AssetCreateDialog";
import AssetGrid from "./AssetGrid";
import AssetInspector from "./AssetInspector";
import AssetNav from "./AssetNav";
import AssetToolbar from "./AssetToolbar";
import CreateFolderDialog from "./CreateFolderDialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AssetsModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { notification: notif } = App.useApp();
  const folders = useAssetsStore((s) => s.folders);
  const addAssetsBatch = useAssetsStore((s) => s.addAssetsBatch);
  const addFolder = useAssetsStore((s) => s.addFolder);
  const renameFolder = useAssetsStore((s) => s.renameFolder);
  const updateAsset = useAssetsStore((s) => s.updateAsset);
  const removeAssetsBatch = useAssetsStore((s) => s.removeAssetsBatch);
  const removeFolder = useAssetsStore((s) => s.removeFolder);
  const updateAssetsBatch = useAssetsStore((s) => s.updateAssetsBatch);
  const getChildFolders = useAssetsStore((s) => s.getChildFolders);

  const gridRef = useRef<HTMLDivElement>(null);

  const [activeScope, setActiveScope] = useState<AssetScope>("personal");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const getUncategorizedFolder = useAssetsStore((s) => s.getUncategorizedFolder);
  const uncategorizedFolder = getUncategorizedFolder(activeScope);
  const [categories, setCategories] = useState<AssetType[]>([]);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);

  // Rename folder state
  const [renamingFolder, setRenamingFolder] = useState<AssetFolder | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const [folderRenameSaving, setFolderRenameSaving] = useState(false);
  const [folderRenameError, setFolderRenameError] = useState("");

  // Delete confirm state —— 单个资产与批量删除各自独立，避免确认文案与实际删除集合不一致。
  const [deleteAsset, setDeleteAsset] = useState<AssetItem | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Delete folder confirm state
  const [deleteFolder, setDeleteFolder] = useState<AssetFolder | null>(null);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchMoving, setBatchMoving] = useState(false);
  const [batchTypeOpen, setBatchTypeOpen] = useState(false);
  const [batchTypeValue, setBatchTypeValue] = useState<AssetType | undefined>(undefined);
  const [batchTypeSaving, setBatchTypeSaving] = useState(false);

  // 与画布抽屉共用同一条查询链路，弹窗只负责展示和批量操作。
  const {
    items,
    totalCount,
    loading,
    loadingMore,
    loadError,
    hasMore,
    reload,
    loadMore: fetchNextPage,
    retry,
    removeItems,
    setItems,
  } = useAssetLibrary({
    enabled: open,
    scope: activeScope,
    folderId: activeFolderId,
    search,
    categories,
  });

  // 搜索词或分类变化后旧勾选可能已不在结果中，在事件中清空，避免批量操作误带不可见项。
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setSelectedIds(new Set());
  }, []);
  const handleCategoriesChange = useCallback((next: AssetType[]) => {
    setCategories(next);
    setSelectedIds(new Set());
  }, []);

  // 卡片本体单击 = 单选并展开右侧检查器；Ctrl/⌘ 点击 = 增减多选。
  // 勾选框点击走 handleToggleSelect，只增减不替换。
  const handleCardSelect = useCallback((asset: AssetItem, additive?: boolean) => {
    setSelectedIds((prev) => {
      if (!additive) return prev.has(asset.id) && prev.size === 1 ? prev : new Set([asset.id]);
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, []);

  const handleToggleSelect = useCallback((asset: AssetItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, []);

  // Selection —— 全选仅覆盖已加载页，工具条同时展示「已选 / 总数」提示范围。
  const allSelected = items.length > 0 && items.every((a) => selectedIds.has(a.id));
  // 检查器只展示仍在当前列表中的勾选项；翻页 / 筛选回收的项不影响批量 id 集合。
  const selectedAssets = useMemo(
    () => items.filter((a) => selectedIds.has(a.id)),
    [items, selectedIds],
  );

  const handleSelectAll = useCallback(() => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map((a) => a.id)));
  }, [allSelected, items]);

  // 检查器单项详情的所在文件夹名；未分类目录使用本地化名称。
  const inspectorFolderName = useMemo(() => {
    if (selectedAssets.length !== 1) return undefined;
    const folder = folders.find((item) => item.id === selectedAssets[0].folderId);
    if (!folder) return undefined;
    return folder.kind === "uncategorized" ? t("asset.uncategorized") : folder.name;
  }, [selectedAssets, folders, t]);

  const handleUpdateTags = useCallback(async (asset: AssetItem, tags: string[]) => {
    const ok = await updateAsset(asset.id, { tags });
    if (ok) {
      // 与重命名一致：写库成功后同步当前列表，翻页离开后以服务端数据为准。
      setItems((prev) => prev.map((item) => (item.id === asset.id ? { ...item, tags } : item)));
    }
    return ok;
  }, [updateAsset, setItems]);

  const handleUpdatePrompt = useCallback(async (asset: AssetItem, prompt: string) => {
    const ok = await updateAsset(asset.id, { prompt });
    if (ok) {
      setItems((prev) => prev.map((item) => (item.id === asset.id ? { ...item, prompt } : item)));
    }
    return ok;
  }, [updateAsset, setItems]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setBatchDeleteOpen(true);
  }, [selectedIds]);

  const handleBatchDeleteConfirm = useCallback(async () => {
    const ids = [...selectedIds];
    setDeleting(true);
    const result = await removeAssetsBatch(ids);
    setDeleting(false);
    if (!result.ok) return;
    await removeItems(ids);
    setSelectedIds(new Set());
    setBatchDeleteOpen(false);
  }, [selectedIds, removeAssetsBatch, removeItems]);

  const handleSingleDeleteConfirm = useCallback(async () => {
    if (!deleteAsset) return;
    setDeleting(true);
    const result = await removeAssetsBatch([deleteAsset.id]);
    setDeleting(false);
    if (!result.ok) return;
    await removeItems([deleteAsset.id]);
    setSelectedIds((prev) => {
      if (!prev.has(deleteAsset.id)) return prev;
      const next = new Set(prev);
      next.delete(deleteAsset.id);
      return next;
    });
    setDeleteAsset(null);
  }, [deleteAsset, removeAssetsBatch, removeItems]);

  const handleBatchMove = useCallback(async (folderId: string) => {
    const ids = [...selectedIds];
    if (ids.length === 0 || batchMoving) return;
    // 移动到当前所在文件夹：直接收起，不发请求也不刷新。
    if (folderId === activeFolderId) {
      setSelectedIds(new Set());
      setBatchMoveOpen(false);
      return;
    }
    setBatchMoving(true);
    const result = await updateAssetsBatch(ids, { folderId });
    setBatchMoving(false);
    if (!result.ok) return;
    setSelectedIds(new Set());
    setBatchMoveOpen(false);
    // 文件夹内列表：移动成功的项必然离开当前视图，本地剔除并补页；
    // 根目录的跨文件夹搜索结果中这些项仍匹配，保留不动。
    if (activeFolderId !== null) await removeItems(ids);
  }, [selectedIds, batchMoving, activeFolderId, updateAssetsBatch, removeItems]);

  const handleBatchType = useCallback(async (type: AssetType) => {
    const ids = [...selectedIds];
    if (ids.length === 0 || batchTypeSaving) return;
    setBatchTypeSaving(true);
    const result = await updateAssetsBatch(ids, { type });
    setBatchTypeSaving(false);
    if (!result.ok) return;
    setSelectedIds(new Set());
    setBatchTypeOpen(false);
    // 当前筛选的分类集合不含新类型时，这些项应离开视图；其余情况本地改字段。
    if (categories.length > 0 && !categories.includes(type)) {
      await removeItems(ids);
    } else {
      setItems((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, type } : i)));
    }
  }, [selectedIds, batchTypeSaving, categories, updateAssetsBatch, removeItems, setItems]);

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

  // 检查器批量插入：以视口中心为基准错位落位，避免多个节点完全重叠。
  const handleBatchInsert = useCallback((assets: AssetItem[]) => {
    if (assets.length === 0) return;
    const center = getViewportCenter();
    const nodes = assets
      .map((asset, i) => createAssetNode(
        asset,
        { x: center.x + (i % 8) * 40, y: center.y + Math.floor(i / 8) * 40 },
        findFreePosition,
      ))
      .filter((node): node is NonNullable<typeof node> => !!node);
    if (nodes.length > 0) useCanvasStore.getState().addNodes(nodes);
    notif.success({
      title: t("asset.added"),
      description: assets.length === 1 ? assets[0].name : t("asset.addedCount", { count: assets.length }),
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
    async (name: string) => {
      const parentId = activeFolderId ?? undefined;
      const result = await addFolder(name, activeScope, parentId);
      return result.status;
    },
    [addFolder, activeScope, activeFolderId],
  );

  // 素材重命名在检查器标题处内联完成，这里只负责持久化与本地列表同步。
  const handleRenameConfirm = useCallback(async (asset: AssetItem, name: string) => {
    const ok = await updateAsset(asset.id, { name });
    if (ok) {
      setItems((prev) => prev.map((item) => (item.id === asset.id ? { ...item, name } : item)));
    }
    return ok;
  }, [updateAsset, setItems]);

  const handleRenameFolder = useCallback((folder: AssetFolder) => {
    setRenamingFolder(folder);
    setFolderRenameValue(folder.name);
    setFolderRenameError("");
  }, []);
  const handleRenameFolderConfirm = useCallback(async () => {
    if (!renamingFolder || folderRenameSaving) return;
    const name = folderRenameValue.trim();
    if (!name) return;
    setFolderRenameSaving(true);
    const result = await renameFolder(renamingFolder.id, name);
    setFolderRenameSaving(false);
    if (result.status === "updated") {
      setRenamingFolder(null);
      setFolderRenameValue("");
      setFolderRenameError("");
    } else if (result.status === "duplicate") {
      setFolderRenameError(t("asset.folderDuplicate"));
    }
    // failed 时 store 已弹出错误通知，弹窗保留便于重试。
  }, [renamingFolder, folderRenameValue, folderRenameSaving, renameFolder, t]);

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
    [t],
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
  }, [activeFolderId, folders]);

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
        width="94vw"
        centered
        destroyOnHidden
        className="asset-library-modal select-none"
        styles={{
          // antd v6 的 .ant-modal-container 默认带 20px 24px 内边距；资产弹窗三栏要贴边，
          // 外层清零，标题栏内边距在下方作用域 <style> 中覆盖（全局样式用了 !important）。
          container: { padding: 0, background: "var(--canvas-bg)" },
          header: { background: "var(--canvas-bg)" },
          body: { background: "var(--canvas-bg)", padding: 0, maxHeight: "calc(100vh - 100px)", overflow: "hidden" },
        }}
        style={{ maxWidth: 1500 }}
        closeIcon={<span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>}
      >
        <style>{`
          /* 覆盖全局 .ant-modal-header 的 !important 规则：标题栏保留 24px 左右内边距
             （右侧 56px 避让关闭按钮）和 16px 上下内边距，横线不再与 × 按钮重叠。 */
          .asset-library-modal .ant-modal-header {
            padding: 16px 56px 16px 24px !important;
          }
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
        <div className="flex" style={{ height: "calc(90vh - 130px)", minHeight: 520 }}>
          {/* Left sidebar */}
          <div
            className="flex flex-col py-4 border-r shrink-0 px-3"
            style={{ borderColor: "var(--canvas-border)" }}
          >
            <AssetNav
              scopes={spaceLabels}
              activeScope={activeScope}
              activeFolderId={activeFolderId}
              onSelectScope={handleSelectScope}
              onSelectFolder={handleSelectFolder}
              folders={folders}
              folderCounts={folderCounts}
            />
          </div>

          {/* Right main content */}
          <div className="flex-1 flex flex-col py-4 min-w-0">
            {/* Breadcrumb + toolbar：同一行，面包屑在左、搜索/筛选/新建在右 */}
            <div className="flex items-center gap-2 mb-3 flex-shrink-0 px-3">
              <div className="flex items-center gap-1 flex-1 min-w-0">
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

              <AssetToolbar
                search={search}
                onSearchChange={handleSearchChange}
                categories={categories}
                onCategoriesChange={handleCategoriesChange}
                onUpload={() => setCreateOpen(true)}
                onCreateFolder={() => setFolderCreateOpen(true)}
                canCreateFolder={canCreateFolder}
              />
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-auto min-h-0 px-3" style={{ scrollbarGutter: "stable" }} ref={gridRef}>
              <AssetGrid
                assets={items}
                folders={categories.length === 0 && !search.trim() ? gridFolders : undefined}
                folderCounts={folderCounts}
                selectedIds={selectedIds}
                onSelect={handleCardSelect}
                onToggleSelect={handleToggleSelect}
                onInsertCanvas={handleInsertCanvas}
                onEnterFolder={(folder) => setActiveFolderId(folder.id)}
                onDeleteFolder={handleDeleteFolder}
                onRenameFolder={handleRenameFolder}
                loading={loading}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={fetchNextPage}
                loadError={loadError}
                onRetry={retry}
              />
            </div>
          </div>

          {/* 右侧检查器：常驻展示；未选中时为空态提示，选中后为单项详情或批量操作区 */}
          <div
            className="shrink-0 overflow-hidden"
            style={{ width: 300, borderLeft: "1px solid var(--canvas-border)" }}
          >
            <AssetInspector
              assets={selectedAssets}
              totalCount={totalCount}
              allSelected={allSelected}
              folderName={inspectorFolderName}
              onClose={() => setSelectedIds(new Set())}
              onSelectAll={handleSelectAll}
              onInsert={handleInsertCanvas}
              onRenameConfirm={handleRenameConfirm}
              onSingleDelete={handleDelete}
              onBatchInsert={handleBatchInsert}
              onBatchMove={() => setBatchMoveOpen(true)}
              onBatchType={() => { setBatchTypeValue(undefined); setBatchTypeOpen(true); }}
              onBatchDelete={handleBatchDelete}
              onUpdateTags={handleUpdateTags}
              onUpdatePrompt={handleUpdatePrompt}
            />
          </div>
        </div>

        {/* Rename folder modal */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.folder.rename")}</span>}
          open={!!renamingFolder}
          onCancel={() => { if (!folderRenameSaving) { setRenamingFolder(null); setFolderRenameValue(""); setFolderRenameError(""); } }}
          centered
          destroyOnHidden
          width={400}
          footer={
            <div className="flex justify-end gap-2">
              <AppButton onClick={() => setRenamingFolder(null)} disabled={folderRenameSaving}>{t("common.cancel")}</AppButton>
              <AppButton variant="primary" loading={folderRenameSaving} onClick={handleRenameFolderConfirm} disabled={!folderRenameValue.trim()}>{t("common.save")}</AppButton>
            </div>
          }
          styles={{
            header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "20px 24px 8px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
          closeIcon={<span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>}
        >
          <Input
            value={folderRenameValue}
            onChange={(e) => { setFolderRenameValue(e.target.value.slice(0, 50)); setFolderRenameError(""); }}
            onPressEnter={handleRenameFolderConfirm}
            maxLength={50}
            showCount
            status={folderRenameError ? "error" : undefined}
            style={{ background: "var(--canvas-bg-elevated)", borderColor: folderRenameError ? "#ff4d4f" : "var(--canvas-border)", color: "var(--canvas-text)" }}
          />
          {folderRenameError && (
            <div className="text-xs mt-1.5" style={{ color: "#ff4d4f" }}>{folderRenameError}</div>
          )}
        </AppModal>

        {/* Single delete confirm */}
        <ConfirmModal
          open={!!deleteAsset}
          title={t("asset.delete")}
          content={deleteAsset?.name || ""}
          confirmLoading={deleting}
          onOk={handleSingleDeleteConfirm}
          onCancel={() => { if (!deleting) setDeleteAsset(null); }}
        />

        {/* Batch delete confirm —— 取消只关弹窗，保留勾选便于改主意 */}
        <ConfirmModal
          open={batchDeleteOpen}
          title={t("asset.delete")}
          content={t("asset.batchDeleteWarn", { count: selectedIds.size })}
          confirmLoading={deleting}
          onOk={handleBatchDeleteConfirm}
          onCancel={() => { if (!deleting) setBatchDeleteOpen(false); }}
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
              <AppButton onClick={() => setBatchMoveOpen(false)} disabled={batchMoving}>{t("common.cancel")}</AppButton>
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
              disabled={!uncategorizedFolder || batchMoving}
              onClick={() => uncategorizedFolder && handleBatchMove(uncategorizedFolder.id)}
              className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left disabled:opacity-40 disabled:cursor-not-allowed"
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
                    disabled={batchMoving}
                    onClick={() => handleBatchMove(f.id)}
                    className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left disabled:opacity-40"
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
          onCancel={() => { if (!batchTypeSaving) setBatchTypeOpen(false); }}
          centered
          destroyOnHidden
          width={360}
          footer={
            <div className="flex justify-end gap-2">
              <AppButton onClick={() => setBatchTypeOpen(false)} disabled={batchTypeSaving}>{t("common.cancel")}</AppButton>
              <Tooltip title={!batchTypeValue ? t("asset.typeTip") : ""}>
                <span>
                  <AppButton variant="primary" loading={batchTypeSaving} disabled={!batchTypeValue} onClick={() => handleBatchType(batchTypeValue!)}>{t("common.save")}</AppButton>
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
