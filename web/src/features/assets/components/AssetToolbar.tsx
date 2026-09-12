/**
 * 资产库顶部工具条。
 * 提供搜索框、新建下拉（上传资产 / 新建文件夹），
 * 以及有选中项时出现的批量操作区（全选、改分类、移动、删除）。
 */
"use client";

import { CheckSquareOutlined,DeleteOutlined, FolderAddOutlined, FolderOutlined, PlusOutlined, SearchOutlined, TagsOutlined, UploadOutlined } from "@ant-design/icons";
import { Input } from "antd";
import { useRef,useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import { MenuDivider,MenuItem } from "@/components/ui/MenuPopover";
import { useLayerOverlay } from "@/components/ui/modal/layer-context";

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  selectedCount: number;
  allSelected?: boolean;
  onSelectAll?: () => void;
  onBatchDelete?: () => void;
  onBatchMove?: () => void;
  onBatchType?: () => void;
  onUpload?: () => void;
  onCreateFolder?: () => void;
  canCreateFolder?: boolean;
}

export default function AssetToolbar({ search, onSearchChange, selectedCount, allSelected, onSelectAll, onBatchDelete, onBatchMove, onBatchType, onUpload, onCreateFolder, canCreateFolder = true }: Props) {
  const { t } = useTranslation();
  const layerOverlay = useLayerOverlay();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleMenuEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.right - 160 });
    }
    setMenuOpen(true);
  };
  const handleMenuLeave = () => {
    closeTimer.current = setTimeout(() => setMenuOpen(false), 150);
  };
  return (
    <div className="flex items-center gap-3 mb-3">
      <Input
        placeholder={t("asset.search")}
        prefix={<SearchOutlined className="text-white/30" />}
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        allowClear
        style={{
          width: 280,
          height: 36,
          background: "var(--canvas-bg-elevated)",
          borderColor: "var(--canvas-border)",
          color: "var(--canvas-text)",
        }}
      />
      <div className="flex-1" />
      {selectedCount > 0 && (
        <>
          <AppButton style={{ minWidth: 108 }} onClick={onSelectAll}>
            <CheckSquareOutlined />
            {allSelected ? t("common.deselectAll") : t("common.selectAll")}
          </AppButton>
          <AppButton style={{ minWidth: 110 }} onClick={onBatchMove}>
            <FolderOutlined />
            {t("asset.moveTo")}
          </AppButton>
          <AppButton style={{ minWidth: 110 }} onClick={onBatchType}>
            <TagsOutlined />
            {t("asset.changeType")}
          </AppButton>
          {/* 删除是破坏性操作，走 danger 而不是主色 */}
          <AppButton variant="danger" style={{ minWidth: 108 }} onClick={onBatchDelete}>
            <DeleteOutlined />
            {t("common.delete")} ({selectedCount})
          </AppButton>
        </>
      )}
      {/* Hover dropdown */}
      <div
        className="relative"
        onMouseEnter={handleMenuEnter}
        onMouseLeave={handleMenuLeave}
      >
        <AppButton ref={triggerRef} variant="primary">
          <PlusOutlined />
          {t("asset.create")}
        </AppButton>
        {menuOpen && createPortal(
          <div
            className="flex flex-col p-2 gap-0.5 rounded-lg shadow-lg border"
            onMouseEnter={handleMenuEnter}
            onMouseLeave={handleMenuLeave}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              zIndex: 1,
              background: "var(--canvas-bg)",
              borderColor: "var(--canvas-border)",
              minWidth: 160,
              pointerEvents: "auto",
            }}
          >
            <style>{`.menu-popover-item:not(.menu-item-disabled):hover { background: var(--canvas-bg-hover) !important; }`}</style>
            <MenuItem
              onClick={canCreateFolder ? () => { setMenuOpen(false); onCreateFolder?.(); } : undefined}
              dimmed={!canCreateFolder}
              iconRight={!canCreateFolder ? <span style={{ opacity: 0.35 }} /> : undefined}
            >
              <FolderAddOutlined /> {t("asset.createFolder")}
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onUpload?.(); }}>
              <UploadOutlined /> {t("asset.uploadTitle")}
            </MenuItem>
          </div>,
          layerOverlay || document.body
        )}
      </div>
    </div>
  );
}
