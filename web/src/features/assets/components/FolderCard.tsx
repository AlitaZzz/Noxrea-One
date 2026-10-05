/**
 * 资产网格中的文件夹卡片。
 * 展示文件夹名与资产数量，点击进入、悬停显示重命名 / 删除按钮，纯展示组件。
 */

"use client";

import { useTranslation } from "react-i18next";

import { DeleteOutlined, EditOutlined, EllipsisOutlined, FolderOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

  return (
    <Card className="group relative flex aspect-square flex-col gap-0 overflow-hidden border-border bg-popover p-0 transition-colors hover:border-ring">
      {(onDelete || onRename) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("common.moreActions")}
              className="absolute top-1 right-1 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(event) => event.stopPropagation()}
            >
              <EllipsisOutlined aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-32" onClick={(event) => event.stopPropagation()}>
            {onRename && (
              <DropdownMenuItem onSelect={() => onRename(folder)}>
                <EditOutlined aria-hidden="true" />
                {t("common.rename")}
              </DropdownMenuItem>
            )}
            {onRename && onDelete && <DropdownMenuSeparator />}
            {onDelete && (
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(folder)}>
                <DeleteOutlined aria-hidden="true" />
                {t("common.delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <CardContent className="h-full p-0">
        <Button
          type="button"
          variant="ghost"
          aria-label={folder.name}
          className="h-full w-full flex-col gap-2 rounded-lg p-3 text-center font-normal"
          onClick={() => onClick(folder)}
        >
          <FolderOutlined className="size-10 text-muted-foreground/40" aria-hidden="true" />
          <span className="w-full truncate text-center text-xs text-muted-foreground">{folder.name}</span>
          <span className="text-[10px] text-muted-foreground/60">{count ?? 0} {t("asset.count")}</span>
        </Button>
      </CardContent>
    </Card>
  );
}
