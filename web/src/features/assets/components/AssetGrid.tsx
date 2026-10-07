/**
 * 资产网格列表。
 * 混合渲染文件夹卡片与资产卡片，通过哨兵元素触发无限滚动加载，
 * 并处理加载中 / 空态 / 加载失败重试三种状态。
 */

"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AssetsIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyMedia } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { AssetFolder, AssetItem } from "@/features/assets/types";

import AssetCard from "./AssetCard";
import FolderCard from "./FolderCard";

interface Props {
  assets: AssetItem[];
  folders?: AssetFolder[];
  folderCounts?: Record<string, number>;
  /** 紧凑模式供抽屉等窄容器使用，仅改变栅格密度，不改变查询逻辑。 */
  compact?: boolean;
  /** 悬浮大图预览是画布抽屉的既有交互；弹窗可按需关闭。 */
  showHoverPreview?: boolean;
  /** 悬停显示中央「+」插入按钮（抽屉传入）；弹窗管理场景不传。 */
  showInsertButton?: boolean;
  /** 资产卡片可拖拽到画布插入（抽屉传入）。 */
  draggable?: boolean;
  selectedIds?: Set<string>;
  /** 多选模式：透传给卡片使勾选框常驻。 */
  selectMode?: boolean;
  /** 单击卡片本体（弹窗为单选替换，Ctrl/⌘ 点击增减，抽屉不传）。 */
  onSelect?: (asset: AssetItem, additive?: boolean) => void;
  /** 单击卡片勾选框（多选增减）。 */
  onToggleSelect?: (asset: AssetItem) => void;
  onInsertCanvas?: (asset: AssetItem) => void;
  onEnterFolder: (folder: AssetFolder) => void;
  onDeleteFolder?: (folder: AssetFolder) => void;
  onRenameFolder?: (folder: AssetFolder) => void;
  loading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  loadError?: boolean;
  onRetry?: () => void;
}

export default function AssetGrid({
  assets, folders, folderCounts, compact, showHoverPreview = false, showInsertButton = false, draggable = false, selectedIds, selectMode = false,
  onSelect, onToggleSelect, onInsertCanvas,
  onEnterFolder, onDeleteFolder, onRenameFolder,
  loading, hasMore, loadingMore, onLoadMore,
  loadError, onRetry,
}: Props) {
  const { t } = useTranslation();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, scrollTop: 0 });

  // IntersectionObserver for infinite scroll
  const handleIntersect = useCallback(() => {
    if (hasMore && !loadingMore && onLoadMore) onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const root = el.parentElement?.parentElement ?? null;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) handleIntersect(); },
      { root, rootMargin: "100px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [handleIntersect, hasMore]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    // AssetGrid 的根包装层不滚动；真正的滚动容器是其父元素。
    const scrollParent = grid?.parentElement?.parentElement;
    if (!grid || !scrollParent) return;
    const update = () => setViewport({ width: grid.clientWidth, height: scrollParent.clientHeight, scrollTop: scrollParent.scrollTop });
    update();
    const onScroll = () => setViewport((current) => ({ ...current, scrollTop: scrollParent.scrollTop }));
    const ro = new ResizeObserver(update);
    ro.observe(grid);
    ro.observe(scrollParent);
    scrollParent.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      scrollParent.removeEventListener("scroll", onScroll);
    };
  }, [assets.length, folders?.length]);

  const hasContent = assets.length > 0 || (folders && folders.length > 0);
  const selectable = !!onSelect || !!onToggleSelect;
  const minCellWidth = compact ? 110 : 150;
  const columns = viewport.width > 0 ? Math.max(1, Math.floor((viewport.width + 12) / (minCellWidth + 12))) : 1;
  const entries = useMemo(
    () => [
      ...(folders ?? []).map((folder) => ({ kind: "folder" as const, key: `folder-${folder.id}`, folder })),
      ...assets.map((asset) => ({ kind: "asset" as const, key: `asset-${asset.id}`, asset })),
    ],
    [assets, folders],
  );
  const cellWidth = viewport.width > 0 ? (viewport.width - (columns - 1) * 12) / columns : minCellWidth;
  const rowHeight = cellWidth + 16;
  const rowCount = Math.ceil(entries.length / columns);
  const firstRow = viewport.width > 0 ? Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 2) : 0;
  const lastRow = viewport.width > 0 ? Math.min(rowCount, Math.ceil((viewport.scrollTop + viewport.height) / rowHeight) + 2) : Math.min(rowCount, 4);
  const visibleEntries = entries.slice(firstRow * columns, lastRow * columns);

  if (loading && !hasContent) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Spinner className="size-6 text-primary" />
      </div>
    );
  }

  if (!hasContent) {
    if (loadError && onRetry) {
      return (
        <div className="flex items-center justify-center h-full min-h-[200px]">
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t("asset.retry")}
          </Button>
        </div>
      );
    }
    return (
      <Empty className="h-full min-h-[200px] select-none border-0 p-6">
        <EmptyMedia variant="icon"><AssetsIcon className="size-6" /></EmptyMedia>
        <EmptyDescription className="text-[13px]">{t("asset.empty")}</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div>
      {/* 刷新态：sticky 视口高 + 负底边距占位为 0，转圈始终在网格可视区正中；
          弹窗与抽屉两个滚动容器复用，避免各自实现浮层。 */}
      {loading && hasContent && (
        <div className="grid-loading-overlay">
          <Spinner className="size-6 text-primary" />
        </div>
      )}
      <div ref={gridRef} className="relative pb-2" style={{ height: Math.max(rowCount * rowHeight, rowHeight) }}>
        {Array.from({ length: Math.max(0, lastRow - firstRow) }, (_, rowOffset) => {
          const row = firstRow + rowOffset;
          const rowEntries = visibleEntries.slice(rowOffset * columns, (rowOffset + 1) * columns);
          return (
            <div
              key={row}
              className="absolute left-0 right-0 grid gap-x-3"
              style={{ top: row * rowHeight, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {rowEntries.map((entry) => entry.kind === "folder" ? (
                <FolderCard
                  key={entry.key}
                  folder={entry.folder}
                  count={folderCounts?.[entry.folder.id] || 0}
                  onClick={onEnterFolder}
                  onDelete={entry.folder.kind === "uncategorized" ? undefined : onDeleteFolder}
                  onRename={entry.folder.kind === "uncategorized" ? undefined : onRenameFolder}
                />
              ) : (
                <AssetCard
                  key={entry.key}
                  asset={entry.asset}
                  selectable={selectable}
                  showHoverPreview={showHoverPreview}
                  showInsertButton={showInsertButton}
                  draggable={draggable}
                  selected={selectedIds?.has(entry.asset.id)}
                  selectMode={selectMode}
                  onSelect={onSelect}
                  onToggleSelect={onToggleSelect}
                  onInsertCanvas={onInsertCanvas}
                />
              ))}
            </div>
          );
        })}
      </div>
      {/* Sentinel + loading indicator */}
      <div ref={sentinelRef} className="flex items-center justify-center py-3">
        {loadingMore && <Spinner className="size-4 text-primary" />}
        {loadError && !loadingMore && onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t("asset.retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
