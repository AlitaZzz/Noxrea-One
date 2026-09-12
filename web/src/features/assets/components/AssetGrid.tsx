/**
 * 资产网格列表。
 * 混合渲染文件夹卡片与资产卡片，通过哨兵元素触发无限滚动加载，
 * 并处理加载中 / 空态 / 加载失败重试三种状态。
 */
"use client";

import { LoadingOutlined } from "@ant-design/icons";
import { Empty, Spin } from "antd";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import type { AssetFolder,AssetItem } from "@/features/assets/types";

import AssetCard from "./AssetCard";
import FolderCard from "./FolderCard";

/** 加载动画统一使用品牌青柠（见 globals.css：青柠用于链接 / 加载动画 / 徽标 / 选中描边）。 */
const limeIndicator = <LoadingOutlined style={{ color: "var(--canvas-accent)" }} spin />;

interface Props {
  assets: AssetItem[];
  folders?: AssetFolder[];
  folderCounts?: Record<string, number>;
  /** 紧凑模式供抽屉等窄容器使用，仅改变栅格密度，不改变查询逻辑。 */
  compact?: boolean;
  /** 关闭后不渲染重命名 / 删除菜单，适用于只需要插入画布的抽屉。 */
  showActions?: boolean;
  /** 悬浮大图预览是画布抽屉的既有交互；弹窗可按需关闭。 */
  showHoverPreview?: boolean;
  /** 悬浮预览的水平锚点，透传给资产卡片。 */
  hoverPreviewAnchorX?: number;
  selectedIds?: Set<string>;
  onToggleSelect?: (asset: AssetItem) => void;
  onInsertCanvas?: (asset: AssetItem) => void;
  onRename?: (asset: AssetItem) => void;
  onDelete?: (asset: AssetItem) => void;
  onEnterFolder?: (folder: AssetFolder) => void;
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
  assets, folders, folderCounts, compact, showActions = true, showHoverPreview = false, hoverPreviewAnchorX = 0, selectedIds,
  onToggleSelect, onInsertCanvas, onRename, onDelete,
  onEnterFolder, onDeleteFolder, onRenameFolder,
  loading, hasMore, loadingMore, onLoadMore,
  loadError, onRetry,
}: Props) {
  const { t } = useTranslation();
  const sentinelRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver for infinite scroll
  const handleIntersect = useCallback(() => {
    if (hasMore && !loadingMore && onLoadMore) onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) handleIntersect(); },
      { rootMargin: "100px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [handleIntersect, hasMore]);

  const hasContent = assets.length > 0 || (folders && folders.length > 0);

  if (loading && !hasContent) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Spin indicator={limeIndicator} />
      </div>
    );
  }

  if (!hasContent) {
    if (loadError && onRetry) {
      return (
        <div className="flex items-center justify-center h-full min-h-[200px]">
          <AppButton variant="ghost" size="sm" onClick={onRetry}>
            {t("asset.retry")}
          </AppButton>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Empty description={<span className="text-white/30">{t("asset.empty")}</span>} />
      </div>
    );
  }

  return (
    <div>
      {/* 固定高度的刷新指示槽：切换条件时小转圈出现/消失不会把网格顶动 */}
      <div className="flex items-center justify-center h-6">
        {loading && hasContent && <Spin size="small" indicator={limeIndicator} />}
      </div>
      <div className="grid gap-3 pb-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? 110 : 150}px, 1fr))` }}>
        {/* Folders first */}
        {folders?.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            count={folderCounts?.[folder.id] || 0}
            onClick={onEnterFolder || (() => {})}
            onDelete={folder.kind === "uncategorized" ? undefined : onDeleteFolder}
            onRename={folder.kind === "uncategorized" ? undefined : onRenameFolder}
          />
        ))}
        {/* Then assets */}
        {assets.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            showActions={showActions}
            showHoverPreview={showHoverPreview}
            hoverPreviewAnchorX={hoverPreviewAnchorX}
            selected={selectedIds?.has(asset.id)}
            onToggleSelect={onToggleSelect}
            onInsertCanvas={onInsertCanvas}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
      {/* Sentinel + loading indicator */}
      <div ref={sentinelRef} className="flex items-center justify-center py-3">
        {loadingMore && <Spin size="small" indicator={limeIndicator} />}
        {loadError && !loadingMore && onRetry && (
          <AppButton variant="ghost" size="sm" onClick={onRetry}>
            {t("asset.retry")}
          </AppButton>
        )}
      </div>
    </div>
  );
}
