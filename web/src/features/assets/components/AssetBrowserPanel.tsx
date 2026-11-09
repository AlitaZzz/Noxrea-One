/**
 * 画布资源管理器中的资产快捷区。
 * 分页浏览资产文件夹与素材，支持搜索、类型筛选、悬浮预览与插入画布。
 * 查询、防抖、分页与错误重试完全交给资产实体；本组件只负责紧凑展示与交互。
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { FilterIcon, FolderOpenOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/input-group";
import { SheetFooter } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import {
  type AssetFolder,
  type AssetItem,
  type AssetType,
  useAssetFolders,
  useAssetLibrary,
} from "@/entities/asset";
import { ASSET_CATEGORIES } from "@/lib/constants";

import { computeRecursiveFolderCounts, getFolderPath, selectGridFolders } from "../folders";
import AssetBreadcrumb from "./AssetBreadcrumb";
import AssetGrid from "./AssetGrid";

interface Props {
  /** 把资产插入画布；落位与历史由画布实现，本组件只负责提示。 */
  onInsertAsset: (asset: AssetItem) => void;
}

export default function AssetBrowserPanel({ onInsertAsset }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const folders = useAssetFolders();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<AssetType[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  const {
    items,
    totalCount,
    loading,
    loadingMore,
    loadError,
    hasMore,
    loadMore,
    retry,
    appliedSearch,
  } = useAssetLibrary({
    enabled: true,
    scope: "personal",
    folderId: activeFolderId,
    search,
    categories: typeFilter,
  });

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    onInsertAsset(asset);
    message.success(t("asset.added"));
  }, [message, onInsertAsset, t]);

  // 完整祖先面包屑链（从根到当前文件夹）
  const breadcrumb = useMemo(
    () => getFolderPath(folders, activeFolderId),
    [activeFolderId, folders],
  );

  // 与资产弹窗共用同一套递归计数逻辑，保证目录数量一致。
  const recursiveCounts = useMemo(
    () => computeRecursiveFolderCounts(folders),
    [folders],
  );

  const gridFolders = useMemo<AssetFolder[]>(
    () => selectGridFolders(folders, "personal", activeFolderId, t("asset.uncategorized")),
    [activeFolderId, folders, t],
  );

  // 用生效搜索词（appliedSearch）而非原始输入：清空搜索时与资产列表同帧切换，避免两者短暂叠加。
  const showFolderGrid = typeFilter.length === 0 && !appliedSearch.trim();

  return (
    // canvas-asset-drawer：画布拖放链路的排除标记（CanvasSurface 的 shouldIgnoreFileDrop），
    // 使抽屉区域不作为画布落点——拖到抽屉上透传建节点 / 触发上传均被拦截
    <div className="canvas-asset-drawer flex flex-col h-full">
      {/* 搜索栏 + 风格筛选 */}
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <SearchInput
          placeholder={t("asset.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          clearable
          onClear={() => setSearch("")}
          containerClassName="h-8 flex-1"
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-pressed={typeFilter.length > 0}
                  className={typeFilter.length > 0 ? "bg-muted text-foreground" : undefined}
                >
                  <FilterIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("asset.filter")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="bottom" align="end" className="w-52">
            <DropdownMenuLabel>{t("asset.filter")}</DropdownMenuLabel>
            {ASSET_CATEGORIES.filter((category): category is typeof category & { key: AssetType } => category.key !== "all").map((st) => (
              <DropdownMenuCheckboxItem
                key={st.key}
                checked={typeFilter.includes(st.key)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => {
                  setTypeFilter((prev) =>
                    checked ? [...prev, st.key] : prev.filter((k) => k !== st.key),
                  );
                }}
              >
                {t(st.labelKey)}
              </DropdownMenuCheckboxItem>
            ))}
            {typeFilter.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setTypeFilter([])}>
                  {t("asset.filterClear")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 面包屑：完整祖先层级，逐级可点击；根视图也显示「个人资产库」。
          统一使用 Breadcrumb 的 Chevron 分隔符，保持层级和主题样式一致。 */}
      <AssetBreadcrumb
        rootLabel={t("asset.spacePersonal")}
        folders={breadcrumb}
        activeFolderId={activeFolderId}
        onNavigate={(folderId) => {
          setSearch("");
          setTypeFilter([]);
          setActiveFolderId(folderId);
        }}
        getFolderLabel={(folder) => folder.kind === "uncategorized" ? t("asset.uncategorized") : folder.name}
        collapsedLabel={t("asset.showParentFolders")}
        className="shrink-0 px-4 pb-2 text-xs"
        itemClassName="whitespace-nowrap text-xs"
      />

      {/* 紧凑资产网格；查询、加载、空态和重试逻辑由 AssetGrid / 资产 Hook 统一处理。
          首页加载期间沿用旧列表占位会短暂撑高容器，临时隐藏滚动条避免其闪现。 */}
      <div
        className={`scrollbar-ui scrollbar-ui-compact min-h-0 flex-1 px-4 pb-3 ${loading ? "overflow-hidden" : "overflow-y-auto"}`}
        style={{ scrollbarGutter: "stable" }}
      >
        <AssetGrid
          assets={items}
          folders={showFolderGrid ? gridFolders : undefined}
          folderCounts={recursiveCounts}
          compact
          showHoverPreview
          showInsertButton
          draggable
          onInsertCanvas={handleInsertCanvas}
          onEnterFolder={(folder) => { setSearch(""); setTypeFilter([]); setActiveFolderId(folder.id); }}
          loading={loading}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          loadError={loadError}
          onRetry={retry}
        />
      </div>

      {/* 底部统计 */}
      <SheetFooter
        className="flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
      >
        {activeFolderId === null && typeFilter.length === 0 && !search.trim() ? (
          <>
            <FolderOpenOutlined />
            <span>{gridFolders.length} {t("asset.foldersLabel")}</span>
          </>
        ) : (
          <>
            <FolderOpenOutlined />
            <span>{totalCount || items.length} {t("asset.count")}</span>
          </>
        )}
      </SheetFooter>
    </div>
  );
}
