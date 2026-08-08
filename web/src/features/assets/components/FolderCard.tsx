/**
 * 资产网格中的文件夹卡片。
 * 展示文件夹名与资产数量，点击进入、悬停显示删除按钮，纯展示组件。
 */
"use client";

import { DeleteOutlined, FolderOutlined } from "@ant-design/icons";

import type { AssetFolder } from "@/features/assets/types";
import { useTranslation } from "react-i18next";

interface Props {
  folder: AssetFolder;
  count?: number;
  onClick: (folder: AssetFolder) => void;
  onDelete?: (folder: AssetFolder) => void;
}

export default function FolderCard({ folder, count, onClick, onDelete }: Props) {
  const { t } = useTranslation();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(folder);
  };

  return (
    <div
      onClick={() => onClick(folder)}
      className="relative group rounded-lg overflow-hidden border border-white/10 hover:border-white/30 transition-all cursor-pointer flex flex-col items-center justify-center gap-2"
      style={{ background: "var(--canvas-bg-elevated)", aspectRatio: "1" }}
    >
      {onDelete && (
        <button
          onClick={handleDelete}
          title={t("asset.folder.delete")}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 p-1 rounded text-white/40 hover:text-white hover:bg-white/10"
        >
          <DeleteOutlined />
        </button>
      )}
      <FolderOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
      <div className="text-white/70 text-xs px-2 text-center truncate w-full">{folder.name}</div>
      <div className="text-white/25 text-[10px]">{count ?? 0} {t("asset.count")}</div>
    </div>
  );
}
