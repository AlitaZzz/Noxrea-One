/**
 * 资产网格中的文件夹卡片。
 * 展示文件夹名与资产数量，点击进入、悬停显示重命名 / 删除按钮，纯展示组件。
 * 操作按钮复用统一图标按钮类 .app-icon-btn（hover 与按下同色），不另立样式。
 */
"use client";

import { DeleteOutlined, EditOutlined, FolderOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

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
      className="relative group rounded-lg overflow-hidden border border-white/10 hover:border-white/30 transition-all cursor-pointer flex flex-col items-center justify-center gap-2"
      style={{ background: "var(--canvas-bg-elevated)", aspectRatio: "1" }}
    >
      {(onDelete || onRename) && (
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          {onRename && (
            <Tooltip title={t("common.edit")}>
              <Button
                type="text"
                size="small"
                className="app-icon-btn"
                icon={<EditOutlined />}
                onClick={stop(onRename)}
              />
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip title={t("common.delete")}>
              <Button
                type="text"
                size="small"
                className="app-icon-btn"
                icon={<DeleteOutlined />}
                onClick={stop(onDelete)}
              />
            </Tooltip>
          )}
        </div>
      )}
      <FolderOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
      <div className="text-white/70 text-xs px-2 text-center truncate w-full">{folder.name}</div>
      <div className="text-white/25 text-[10px]">{count ?? 0} {t("asset.count")}</div>
    </div>
  );
}
