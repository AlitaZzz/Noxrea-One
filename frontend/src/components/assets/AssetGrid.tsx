"use client";

import { Empty } from "antd";
import type { AssetItem, AssetFolder } from "@/lib/types";
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
}

export default function AssetGrid({ assets, folders, folderCounts, selectedIds, onToggleSelect, onInsertCanvas, onRename, onDelete, onEnterFolder, onDeleteFolder }: Props) {
  const t = useI18nStore((s) => s.t);

  const hasContent = assets.length > 0 || (folders && folders.length > 0);

  if (!hasContent) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Empty description={<span className="text-white/30">{t("asset.empty")}</span>} />
      </div>
    );
  }

  return (
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
  );
}
