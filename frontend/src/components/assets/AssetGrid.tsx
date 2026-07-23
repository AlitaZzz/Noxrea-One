"use client";

import { Empty, Spin } from "antd";
import { useCallback, useEffect, useRef } from "react";

import type { AssetFolder,AssetItem } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";

import AssetCard from "./AssetCard";
import FolderCard from "./FolderCard";

interface Props {
  assets: AssetItem[];
  folders?: AssetFolder[];
  folderCounts?: Record<string, number>;
  selectedIds?: Set<string>;
  onToggleSelect?: (asset: AssetItem) => void;
  onInsertCanvas?: (asset: AssetItem) => void;
  onRename?: (asset: AssetItem) => void;
  onDelete?: (asset: AssetItem) => void;
  onEnterFolder?: (folder: AssetFolder) => void;
  onDeleteFolder?: (folder: AssetFolder) => void;
  loading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  loadError?: boolean;
  onRetry?: () => void;
}

export default function AssetGrid({
  assets, folders, folderCounts, selectedIds,
  onToggleSelect, onInsertCanvas, onRename, onDelete,
  onEnterFolder, onDeleteFolder,
  loading, hasMore, loadingMore, onLoadMore,
  loadError, onRetry,
}: Props) {
  const t = useI18nStore((s) => s.t);
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
        <Spin />
      </div>
    );
  }

  if (!hasContent) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Empty description={<span className="text-white/30">{t("asset.empty")}</span>} />
      </div>
    );
  }

  return (
    <div>
      <div className="grid gap-3 pb-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {/* Folders first */}
        {folders?.map((folder) => (
          <FolderCard key={folder.id} folder={folder} count={folderCounts?.[folder.id] || 0} onClick={onEnterFolder || (() => {})} onDelete={onDeleteFolder} />
        ))}
        {/* Then assets */}
        {assets.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
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
        {loadingMore && <Spin size="small" />}
        {loadError && !loadingMore && onRetry && (
          <button
            onClick={onRetry}
            className="text-xs px-3 py-1 rounded transition-colors hover:bg-white/5"
            style={{ color: "var(--canvas-text-dim)" }}
          >
            {t("asset.retry")}
          </button>
        )}
        {!hasMore && !loadError && assets.length > 0 && (
          <span className="text-xs text-white/20">{t("asset.count")}</span>
        )}
      </div>
    </div>
  );
}
