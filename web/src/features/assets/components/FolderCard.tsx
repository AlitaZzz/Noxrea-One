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
  layout?: "grid" | "list";
  onClick: (folder: AssetFolder) => void;
  onDelete?: (folder: AssetFolder) => void;
  onRename?: (folder: AssetFolder) => void;
}

export default function FolderCard({ folder, count, layout = "grid", onClick, onDelete, onRename }: Props) {
  const { t } = useTranslation();

  const stop = (handler: (folder: AssetFolder) => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    handler(folder);
  };

  if (layout === "list") {
    return (
      <div
        onClick={() => onClick(folder)}
        className="relative group flex items-center gap-3 rounded-lg border border-white/10 hover:border-white/30 transition-colors cursor-pointer px-2"
        style={{ height: 60, background: "var(--canvas-bg-elevated)" }}
      >
        {(onDelete || onRename) && (
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 order-3 ml-auto">
            {onRename && (
              <Tooltip title={t("common.edit")}>
                <Button type="text" size="small" className="app-icon-btn" icon={<EditOutlined />} onClick={stop(onRename)} />
              </Tooltip>
            )}
            {onDelete && (
              <Tooltip title={t("common.delete")}>
                <Button type="text" size="small" className="app-icon-btn" icon={<DeleteOutlined />} onClick={stop(onDelete)} />
              </Tooltip>
            )}
          </div>
        )}
        <div className="w-10 h-10 rounded-md flex items-center justify-center shrink-0" style={{ background: "var(--canvas-bg)" }}>
          <FolderOutlined style={{ fontSize: 18, color: "rgba(255,255,255,0.35)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs truncate font-medium" style={{ color: "var(--canvas-text)" }}>{folder.name}</div>
          <div className="text-[10px] mt-0.5" style={{ color: "var(--canvas-text-muted)" }}>{count ?? 0} {t("asset.count")}</div>
        </div>
      </div>
    );
  }

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
