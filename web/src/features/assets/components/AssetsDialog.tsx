/**
 * 资产库主弹窗，资产模块的容器与编排层。
 * 组合左侧空间 / 文件夹树、顶部分类页签与工具条、主体资产网格，
 * 统一处理分页加载、搜索筛选、批量选择与批量删除 / 移动 / 改类型、
 * 文件夹增删改，以及「插入画布」（经 createAssetNode 转成画布节点）。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloseOutlined, DeleteOutlined, DownloadOutlined, FolderOutlined, PlusOutlined, SwapOutlined } from "@/components/ui/AppIcon";
import { AssetsIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TreeSelect } from "@/components/ui/tree-select";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { createAssetNode } from "@/features/assets/add-asset";
import { useAssetLibrary } from "@/features/assets/hooks/use-asset-library";
import { normalizeFolderId, ROOT_FOLDER_ID, useFolderTree } from "@/features/assets/hooks/use-folder-tree";
import { splitMatch, useTreeMatchTitle } from "@/features/assets/hooks/use-tree-match";
import { computeRecursiveFolderCounts, useAssetsStore } from "@/features/assets/store";
import type { AssetFolder, AssetItem, AssetScope, AssetType, CreateAssetInput } from "@/features/assets/types";
import { findFreePosition, getViewportCenter, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { ASSET_CATEGORIES } from "@/lib/constants";

import { downloadAsset } from "../download";
import AssetCreateDialog from "./AssetCreateDialog";
import AssetGrid from "./AssetGrid";
import AssetInspector from "./AssetInspector";
import AssetToolbar from "./AssetToolbar";
import CreateFolderDialog from "./CreateFolderDialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AssetsDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
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

  // 空间固定为个人库（当前只有该空间）；状态保留供查询链路使用，将来加回系统库时恢复切换即可。
  const [activeScope] = useState<AssetScope>("personal");
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
  const [folderDeleting, setFolderDeleting] = useState(false);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 显式多选模式（工具条勾选图标切换）；一旦勾到 ≥2 项也自动视为多选态。
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchMoveTarget, setBatchMoveTarget] = useState<string | undefined>(undefined);
  const [batchMoving, setBatchMoving] = useState(false);
  // 移动弹窗文件夹树的搜索态（命中片段高亮，逻辑见 use-tree-match）
  const { query: moveTreeQuery, onSearch: onMoveTreeSearch, reset: resetMoveTreeSearch } = useTreeMatchTitle();
  const [batchTypeOpen, setBatchTypeOpen] = useState(false);
  const [batchTypeValue, setBatchTypeValue] = useState<AssetType | undefined>(undefined);
  const [batchTypeSaving, setBatchTypeSaving] = useState(false);

  // 与画布抽屉共用同一条查询链路，弹窗只负责展示和批量操作。
  const {
    items,
    loading,
    loadingMore,
    loadError,
    hasMore,
    reload,
    loadMore: fetchNextPage,
    retry,
    removeItems,
    setItems,
    appliedSearch,
  } = useAssetLibrary({
    enabled: open,
    scope: activeScope,
    folderId: activeFolderId,
    search,
    categories,
  });

  // 资产条目在视图外变更（画布收藏 / 取消收藏等）时失效重拉；弹窗关闭期间只记账，
  // 重开时 enabled 的查询链路自然会取最新数据。
  const libraryVersion = useAssetsStore((s) => s.libraryVersion);
  const lastLibraryVersionRef = useRef(libraryVersion);
  useEffect(() => {
    if (libraryVersion === lastLibraryVersionRef.current) return;
    lastLibraryVersionRef.current = libraryVersion;
    if (open) reload();
  }, [libraryVersion, open, reload]);

  // 搜索词或分类变化后旧勾选可能已不在结果中，在事件中清空，避免批量操作误带不可见项。
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setSelectedIds(new Set());
    setMultiSelectMode(false);
  }, []);
  const handleCategoriesChange = useCallback((next: AssetType[]) => {
    setCategories(next);
    setSelectedIds(new Set());
    setMultiSelectMode(false);
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

  // ≥2 项时批量操作从检查器移到网格正上方的批量条；检查器只留选择摘要。
  const bulkOpen = selectedIds.size >= 2;
  // 多选模式：勾选框常驻、卡片点击直接增减；关闭时一并清空选择。
  const multiMode = multiSelectMode || bulkOpen;
  const openBatchMove = useCallback(() => {
    setBatchMoveTarget(undefined);
    resetMoveTreeSearch();
    setBatchMoveOpen(true);
  }, [resetMoveTreeSearch]);
  const handleToggleMultiMode = useCallback(() => {
    if (multiSelectMode) setSelectedIds(new Set());
    setMultiSelectMode(!multiSelectMode);
  }, [multiSelectMode]);
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setMultiSelectMode(false);
  }, []);

  // 多选模式下卡片单击直接增减；否则保持单选替换 / Ctrl 增减语义。
  const handleGridCardSelect = useCallback((asset: AssetItem, additive?: boolean) => {
    if (multiMode) handleToggleSelect(asset);
    else handleCardSelect(asset, additive);
  }, [multiMode, handleToggleSelect, handleCardSelect]);

  // 检查器单项详情的所在文件夹名；未分类目录使用本地化名称。
  // 检查器「位置」显示完整路径：根空间 + 祖先链 + 当前文件夹，与面包屑层级一致
  const inspectorFolderPath = useMemo(() => {
    if (selectedAssets.length !== 1) return undefined;
    const folderId = selectedAssets[0].folderId;
    if (!folderId) return t("asset.spacePersonal");
    const names: string[] = [];
    let cur = folders.find((f) => f.id === folderId);
    while (cur) {
      names.unshift(cur.kind === "uncategorized" ? t("asset.uncategorized") : cur.name);
      const parentId = cur.parentId;
      cur = parentId ? folders.find((f) => f.id === parentId) : undefined;
    }
    return [t("asset.spacePersonal"), ...names].join(" / ");
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
    setMultiSelectMode(false);
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
    // 目标与当前位置一致（待分类视作根目录）：直接收起，不发请求也不刷新。
    const targetId = normalizeFolderId(folders, folderId);
    if (targetId === normalizeFolderId(folders, activeFolderId)) {
      setSelectedIds(new Set());
      setMultiSelectMode(false);
      setBatchMoveOpen(false);
      return;
    }
    setBatchMoving(true);
    // 根目录 = 无文件夹：服务端把 null 归入待分类目录（待分类即根目录的实现载体）
    const result = await updateAssetsBatch(ids, { folderId: targetId === ROOT_FOLDER_ID ? null : targetId });
    setBatchMoving(false);
    if (!result.ok) return;
    setSelectedIds(new Set());
    setMultiSelectMode(false);
    setBatchMoveOpen(false);
    // 文件夹内列表：移动成功的项必然离开当前视图，本地剔除并补页；
    // 根目录是全量视图（跨文件夹搜索结果中这些项仍匹配），保留不动。
    if (activeFolderId !== null) await removeItems(ids);
  }, [selectedIds, batchMoving, activeFolderId, folders, updateAssetsBatch, removeItems]);

  const handleBatchType = useCallback(async (type: AssetType) => {
    const ids = [...selectedIds];
    if (ids.length === 0 || batchTypeSaving) return;
    setBatchTypeSaving(true);
    const result = await updateAssetsBatch(ids, { type });
    setBatchTypeSaving(false);
    if (!result.ok) return;
    setSelectedIds(new Set());
    setMultiSelectMode(false);
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

  // 文件夹只在无分类筛选、无搜索词时参与网格。
  // 用生效搜索词（appliedSearch）而非原始输入：清空搜索时与资产列表同帧切换，避免两者短暂叠加。
  const gridShowFolders = categories.length === 0 && !appliedSearch.trim();

  // 移动弹窗的目标树：与上传弹窗共用 useFolderTree（个人资产库为根 + 普通文件夹递归），
  // 当前所在位置禁选（待分类视作根目录）。项目 TreeSelect 提供折叠与搜索，目录再多也可扩展。
  const renderMoveTitle = useCallback((name: string) => {
    const m = splitMatch(name, moveTreeQuery);
    if (!m) return <>{name}</>;
    return (
      <>
        {m.pre}
        <span className="app-tree-match">{m.hit}</span>
        {m.post}
      </>
    );
  }, [moveTreeQuery]);
  const moveTreeData = useFolderTree(folders, renderMoveTitle, normalizeFolderId(folders, activeFolderId));

  // --- Handlers ---

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    const node = createAssetNode(asset, getViewportCenter(), findFreePosition);
    if (node) useCanvasStore.getState().addNodes([node]);
    message.success(t("asset.added"));
  }, [message, t]);

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
    message.success(t("asset.addedCount", { count: assets.length }));
  }, [message, t]);

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
    if (!deleteFolder || folderDeleting) return;
    const deletedId = deleteFolder.id;
    setFolderDeleting(true);
    const removed = await removeFolder(deletedId);
    setFolderDeleting(false);
    if (!removed) return;
    // 只有删除成功才把用户切回根目录；失败原因由 store 统一通知
    if (activeFolderId) {
      let cur: string | null = activeFolderId;
      let within = false;
      while (cur) {
        if (cur === deletedId) { within = true; break; }
        cur = folders.find((f) => f.id === cur)?.parentId || null;
      }
      if (within) { setActiveFolderId(null); clearSelection(); setSearch(""); }
    }
    clearSelection();
    setDeleteFolder(null);
  }, [deleteFolder, folderDeleting, removeFolder, activeFolderId, folders, clearSelection]);

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
      <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
        <DialogContent
          className="asset-library-modal select-none sm:max-w-none w-[94vw] max-w-[1600px] gap-0 p-0 bg-card"
        >
          <DialogHeader className="border-b px-6 py-6">
            <DialogTitle className="flex items-center gap-2">
              <AssetsIcon className="text-muted-foreground" />
              <span>{t("asset.title")}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[calc(100vh-100px)] overflow-hidden bg-card">
        <div className="flex h-[calc(90vh-130px)] min-h-[520px]">
          {/* Main content：面包屑/工具条、批量条与网格 */}
          <div className="flex-1 flex flex-col pt-3 pb-4 min-w-0">
            {/* Breadcrumb + toolbar：同一行，面包屑在左、搜索/筛选/新建在右 */}
            <div className="flex items-center gap-2 mb-3 flex-shrink-0 px-3">
              <div className="flex items-center gap-1 flex-1 min-w-0">
                {/* 根：个人资产库（根视图为当前项不可点，进入文件夹后可点击返回） */}
                {activeFolderId === null ? (
                  <span className="cursor-default whitespace-nowrap px-2 py-0.5 text-sm text-foreground">
                    {t("asset.spacePersonal")}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => { clearSelection(); setSearch(""); setActiveFolderId(null); }}
                    className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground"
                  >
                    {t("asset.spacePersonal")}
                  </Button>
                )}
                {breadCrumb.map((f) => {
                  const isLast = f.id === activeFolderId;
                  return (
                    <span key={f.id} className="flex items-center gap-1">
                      <span className="text-muted-foreground">/</span>
                      {isLast ? (
                        <span className="cursor-default whitespace-nowrap px-2 py-0.5 text-sm text-foreground">
                          {f.kind === "uncategorized" ? t("asset.uncategorized") : f.name}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => { clearSelection(); setSearch(""); setActiveFolderId(f.id); }}
                          className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground"
                        >
                          {f.kind === "uncategorized" ? t("asset.uncategorized") : f.name}
                        </Button>
                      )}
                    </span>
                  );
                })}
              </div>

              {/* 单选时工具条行显示「已选 1 项」chip；多选由批量条承接，避免两处重复 */}
              {selectedIds.size === 1 && (
                <Tooltip><TooltipTrigger asChild>
                    <Button
                      type="button"
                      onClick={clearSelection}
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                    >
                      {t("asset.selectedN", { count: selectedIds.size })}
                      <CloseOutlined className="size-3 text-muted-foreground" />
                    </Button>
                  </TooltipTrigger><TooltipContent>{t("asset.clearSelection")}</TooltipContent></Tooltip>
              )}

              <AssetToolbar
                search={search}
                onSearchChange={handleSearchChange}
                categories={categories}
                onCategoriesChange={handleCategoriesChange}
                onUpload={() => setCreateOpen(true)}
                onCreateFolder={() => setFolderCreateOpen(true)}
                canCreateFolder={canCreateFolder}
                multiSelect={multiMode}
                onToggleMultiSelect={handleToggleMultiMode}
              />
            </div>

            {/* 多选批量操作条：由 Collapsible 管理可见性和折叠动画，出现/消失平滑推移网格 */}
            <Collapsible open={bulkOpen} className="shrink-0">
              <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                <div className="mx-3 mb-3 flex h-11 items-center gap-0.5 rounded-md border border-input bg-popover px-2.5 pl-3">
                  {/* 使用 shadcn Checkbox 表达全选 / 半选状态，避免手绘控件脱离主题 */}
                  <label className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-[13px] font-medium text-foreground">
                    <Checkbox
                      checked={allSelected ? true : "indeterminate"}
                      onCheckedChange={handleSelectAll}
                      aria-label={t("asset.selectedN", { count: selectedIds.size })}
                    />
                    <span className="whitespace-nowrap text-[13px] font-medium text-foreground">{t("asset.selectedN", { count: selectedIds.size })}</span>
                  </label>
                  <Tooltip><TooltipTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("asset.clearSelection")}
                        onClick={clearSelection}
                      >
                        <CloseOutlined className="size-3" />
                      </Button>
                    </TooltipTrigger><TooltipContent>{t("asset.clearSelection")}</TooltipContent></Tooltip>
                  <div className="flex-1" />
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    disabled={selectedAssets.length === 0}
                    onClick={() => handleBatchInsert(selectedAssets)}
                  >
                    <PlusOutlined className="size-3.5" />
                    {t("asset.addToCanvas")}（{selectedAssets.length}）
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={openBatchMove}>
                    <FolderOutlined className="size-3.5" />
                    {t("asset.moveTo")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => { setBatchTypeValue(undefined); setBatchTypeOpen(true); }}
                  >
                    <SwapOutlined className="size-3.5" />
                    {t("asset.changeType")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={selectedAssets.length === 0}
                    onClick={() => selectedAssets.forEach(downloadAsset)}
                  >
                    <DownloadOutlined className="size-3.5" />
                    {t("common.download")}（{selectedAssets.length}）
                  </Button>
                  <Separator orientation="vertical" className="mx-1.5 h-[18px] self-center" />
                  <Button type="button" size="sm" variant="destructive" onClick={handleBatchDelete}>
                    <DeleteOutlined className="size-3.5" />
                    {t("common.delete")}（{selectedIds.size}）
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Grid。首页加载期间沿用旧列表占位会短暂撑高容器，临时隐藏滚动条避免其闪现。 */}
            <div
              className="flex-1 min-h-0 px-3"
              style={{ scrollbarGutter: "stable", overflow: loading ? "hidden" : "auto" }}
              ref={gridRef}
            >
              <AssetGrid
                assets={items}
                folders={gridShowFolders ? gridFolders : undefined}
                folderCounts={folderCounts}
                selectedIds={selectedIds}
                selectMode={multiMode}
                onSelect={handleGridCardSelect}
                onToggleSelect={handleToggleSelect}
                onInsertCanvas={handleInsertCanvas}
                onEnterFolder={(folder) => { clearSelection(); setSearch(""); setActiveFolderId(folder.id); }}
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
          <div className="w-[360px] shrink-0 overflow-hidden border-l border-border">
            <AssetInspector
              assets={selectedAssets}
              folderPath={inspectorFolderPath}
              onInsert={handleInsertCanvas}
              onRenameConfirm={handleRenameConfirm}
              onSingleDelete={handleDelete}
              onBatchMove={openBatchMove}
              onBatchType={() => { setBatchTypeValue(undefined); setBatchTypeOpen(true); }}
              onUpdateTags={handleUpdateTags}
              onUpdatePrompt={handleUpdatePrompt}
            />
          </div>
        </div>
          </div>

        {/* Rename folder modal */}
        <Dialog open={!!renamingFolder} onOpenChange={(nextOpen) => {
          if (!nextOpen && !folderRenameSaving) { setRenamingFolder(null); setFolderRenameValue(""); setFolderRenameError(""); }
        }}>
          <DialogContent global className="sm:max-w-[400px]">
            <DialogHeader><DialogTitle>{t("asset.folder.rename")}</DialogTitle></DialogHeader>
            <div className="space-y-2">
          <InputGroup>
            <InputGroupInput
              value={folderRenameValue}
              onChange={(e) => { setFolderRenameValue(e.target.value.slice(0, 50)); setFolderRenameError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") void handleRenameFolderConfirm(); }}
              maxLength={50}
              aria-invalid={folderRenameError ? true : undefined}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{folderRenameValue.length} / 50</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
              {folderRenameError && <p className="text-sm text-destructive">{folderRenameError}</p>}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={folderRenameSaving}>{t("common.cancel")}</Button>
              </DialogClose>
              <Button variant="default" loading={folderRenameSaving} onClick={handleRenameFolderConfirm} disabled={!folderRenameValue.trim()}>{t("common.save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmModal
          open={!!deleteAsset}
          global
          title={t("asset.delete")}
          content={t("asset.deleteConfirm", { name: deleteAsset?.name || "" })}
          okText={t("common.delete")}
          cancelText={t("common.cancel")}
          confirmVariant="destructive"
          confirmLoading={deleting}
          onOk={handleSingleDeleteConfirm}
          onCancel={() => { if (!deleting) setDeleteAsset(null); }}
        />

        <ConfirmModal
          open={batchDeleteOpen}
          global
          title={t("asset.delete")}
          content={t("asset.batchDeleteWarn", { count: selectedIds.size })}
          okText={t("common.delete")}
          cancelText={t("common.cancel")}
          confirmVariant="destructive"
          confirmLoading={deleting}
          onOk={handleBatchDeleteConfirm}
          onCancel={() => { if (!deleting) setBatchDeleteOpen(false); }}
        />

        <ConfirmModal
          open={!!deleteFolder}
          global
          title={t("asset.folder.delete")}
          content={t("asset.folder.deleteWarn", { name: deleteFolder?.name || "" })}
          okText={t("common.delete")}
          cancelText={t("common.cancel")}
          confirmVariant="destructive"
          confirmLoading={folderDeleting}
          onOk={handleDeleteFolderConfirm}
          onCancel={() => {
            if (folderDeleting) return;
            setDeleteFolder(null);
            setSelectedIds(new Set());
          }}
        />

        {/* Batch move modal —— 可搜索折叠树，目录规模增长后仍可定位目标 */}
        <Dialog open={batchMoveOpen} onOpenChange={(nextOpen) => { if (!nextOpen && !batchMoving) setBatchMoveOpen(false); }}>
          <DialogContent global className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle>{t("asset.moveTo")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <TreeSelect
                value={batchMoveTarget}
                onChange={(v) => setBatchMoveTarget(v)}
                placeholder={t("asset.folderPickerPlaceholder")}
                searchPlaceholder={t("asset.folderSearchPlaceholder")}
                allowClear
                searchable
                emptyContent={t("common.noData")}
                onSearch={onMoveTreeSearch}
                expandAll
                popupHeight={280}
                nodes={moveTreeData}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={batchMoving}>{t("common.cancel")}</Button>
              </DialogClose>
              <Button
                loading={batchMoving}
                disabled={!batchMoveTarget}
                onClick={() => batchMoveTarget && handleBatchMove(batchMoveTarget)}
              >
                {t("common.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Batch type modal */}
        <Dialog open={batchTypeOpen} onOpenChange={(nextOpen) => { if (!nextOpen && !batchTypeSaving) setBatchTypeOpen(false); }}>
          <DialogContent global className="sm:max-w-[400px]">
            <DialogHeader><DialogTitle>{t("asset.changeType")}</DialogTitle></DialogHeader>
          <Select
            value={batchTypeValue ?? undefined}
            onValueChange={(value) => setBatchTypeValue(value === "__clear__" ? undefined : value as AssetType)}
          >
            <SelectTrigger className="w-full"><SelectValue placeholder={t("asset.typePlaceholder")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__clear__">{t("asset.typePlaceholder")}</SelectItem>
              {ASSET_CATEGORIES.filter((category): category is typeof category & { key: AssetType } => category.key !== "all")
                .map((category) => <SelectItem key={category.key} value={category.key}>{t(category.labelKey)}</SelectItem>)}
            </SelectContent>
          </Select>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={batchTypeSaving}>{t("common.cancel")}</Button>
              </DialogClose>
              <Button variant="default" loading={batchTypeSaving} disabled={!batchTypeValue} onClick={() => handleBatchType(batchTypeValue!)}>{t("common.save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Upload dialog */}
        <AssetCreateDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreateAssets}
          folders={folders}
          defaultFolderId={activeFolderId}
        />

        {/* Create folder dialog */}
        <CreateFolderDialog
          open={folderCreateOpen}
          onClose={() => setFolderCreateOpen(false)}
          onCreate={handleCreateFolder}
        />
        </DialogContent>
      </Dialog>
    </>
  );
}
