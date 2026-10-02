/**
 * 资产网格中的文件夹卡片。
 * 展示文件夹名与资产数量，点击进入、悬停显示重命名 / 删除按钮，纯展示组件。
 */

"use client";

import { useTranslation } from "react-i18next";

import { DeleteOutlined, EditOutlined, FolderOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import type { AssetFolder } from "@/features/assets/types";

interface Props {
  folder: AssetFolder;
  count?: number;
  onClick: (folder: AssetFolder) => void;
  onDelete?: (folder: AssetFolder) => void;
  onRename?: (folder: AssetFolder) => void;
}

export default function FolderCard({ folder, count, onClick, onDelete, onRename }: Props) {
  const { t } = useTranslation();

  const stop = (handler: (folder: AssetFolder) => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    handler(folder);
  };

  return (
    <div
      onClick={() => onClick(folder)}
      className="group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-border bg-popover transition-colors hover:border-ring"
    >
      {(onDelete || onRename) && (
        <div className="absolute top-1 right-1 z-10 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onRename && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("asset.folder.rename")}
              onClick={stop(onRename)}
            ><EditOutlined aria-hidden="true" /></Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("asset.folder.delete")}
              onClick={stop(onDelete)}
            ><DeleteOutlined aria-hidden="true" /></Button>
          )}
        </div>
      )}
      <FolderOutlined className="size-10 text-muted-foreground/40" aria-hidden="true" />
      <div className="w-full truncate px-2 text-center text-xs text-muted-foreground">{folder.name}</div>
      <div className="text-[10px] text-muted-foreground/60">{count ?? 0} {t("asset.count")}</div>
    </div>
  );
}
