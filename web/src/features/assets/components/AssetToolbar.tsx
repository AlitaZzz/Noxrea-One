/**
 * 资产库顶部工具条。
 * 右侧依次为：可向左展开的搜索图标、筛选下拉（多选分类）、新建下拉。
 * 单项 / 批量操作统一收敛到右侧检查器，工具条不随选择态变化。
 */
"use client";

import {
  FolderAddOutlined,
  PlusOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Checkbox, Input, Popover, Tooltip } from "antd";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import FilterIcon from "@/components/ui/icons/common/FilterIcon";
import { MenuItem } from "@/components/ui/MenuPopover";
import { useLayerOverlay } from "@/components/ui/modal/layer-context";
import type { AssetType } from "@/features/assets/types";
import { ASSET_CATEGORIES } from "@/lib/constants";

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  categories: AssetType[];
  onCategoriesChange: (categories: AssetType[]) => void;
  onUpload?: () => void;
  onCreateFolder?: () => void;
  canCreateFolder?: boolean;
}

const SEARCH_WIDTH = 260;
const ICON_WIDTH = 36;

export default function AssetToolbar({
  search, onSearchChange, categories, onCategoriesChange,
  onUpload, onCreateFolder, canCreateFolder = true,
}: Props) {
  const { t } = useTranslation();
  const layerOverlay = useLayerOverlay();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 搜索默认收起为一颗图标，点击后输入框向左展开；失焦且内容为空时自动收回。
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<React.ComponentRef<typeof Input>>(null);
  const searchExpanded = searchOpen || search.trim() !== "";

  const toggleSearch = () => {
    if (!searchExpanded) {
      setSearchOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!search.trim()) {
      setSearchOpen(false);
    } else {
      inputRef.current?.focus();
    }
  };

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

  const filterContent = (
    <div className="menu-popover asset-filter-popover">
      <div style={{ padding: "2px 12px 4px", fontSize: 11, color: "var(--canvas-text-muted)" }}>
        {t("asset.filter")}
      </div>
      {ASSET_CATEGORIES.filter(
        (category): category is typeof category & { key: AssetType } => category.key !== "all",
      ).map((cat) => (
        <label key={cat.key} className="filter-row">
          <Checkbox
            checked={categories.includes(cat.key)}
            onChange={(e) => {
              onCategoriesChange(
                e.target.checked
                  ? [...categories, cat.key]
                  : categories.filter((k) => k !== cat.key),
              );
            }}
          >
            {t(cat.labelKey)}
          </Checkbox>
        </label>
      ))}
      {categories.length > 0 && (
        <>
          <div className="menu-divider" />
          <div
            className="filter-row"
            onClick={() => onCategoriesChange([])}
            style={{ color: "var(--canvas-text-dim)", fontSize: 13 }}
          >
            {t("asset.filterClear")}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* 清除 × 让到固定搜索图标的左侧，避免两个图标叠在输入框右缘 */}
      <style>{`.asset-search-input .ant-input-clear-icon { inset-inline-end: 40px; }`}</style>

      {/* 搜索：收起态仅图标，展开态图标固定在右端、输入框向左生长 */}
      <div className="relative shrink-0 transition-[width] duration-200 ease-out" style={{ width: searchExpanded ? SEARCH_WIDTH : ICON_WIDTH, height: ICON_WIDTH }}>
        {searchExpanded && (
          <Input
            ref={inputRef}
            placeholder={t("asset.search")}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onBlur={() => { if (!search.trim()) setSearchOpen(false); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { onSearchChange(""); setSearchOpen(false); }
            }}
            allowClear
            className="asset-search-input w-full"
            style={{
              height: ICON_WIDTH,
              paddingRight: 64,
              background: "var(--canvas-bg-elevated)",
              borderColor: "var(--canvas-border)",
              color: "var(--canvas-text)",
            }}
          />
        )}
        <Tooltip title={t("asset.search")}>
          <button
            type="button"
            // 阻止按下时输入框失焦：否则空内容会先自动收回、click 又展开，宽度抖一下
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleSearch}
            className="app-icon-btn app-icon-btn--md absolute top-0 right-0 z-10"
            aria-label={t("asset.search")}
            style={{ color: "#fff", fontSize: 18 }}
          >
            <SearchOutlined />
          </button>
        </Tooltip>
      </div>

      {/* 筛选：多选分类，选中任一分类后按钮常驻高亮 */}
      <Popover
        trigger="click"
        placement="bottomRight"
        styles={{ container: { padding: 0, background: "transparent" } }}
        content={filterContent}
      >
        <Tooltip title={t("asset.filter")}>
          <button
            type="button"
            className={`app-icon-btn app-icon-btn--md${categories.length > 0 ? " is-active" : ""}`}
            aria-label={t("asset.filter")}
            style={{ color: "#fff", fontSize: 18 }}
          >
            <FilterIcon />
          </button>
        </Tooltip>
      </Popover>

      {/* 新建下拉 */}
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
              // 需高于资产卡片的多选框（z-10），否则菜单会盖在卡片上时被勾选框压住
              zIndex: 1050,
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
            <MenuItem
              onClick={() => { setMenuOpen(false); onUpload?.(); }}
            >
              <UploadOutlined /> {t("asset.uploadTitle")}
            </MenuItem>
          </div>,
          layerOverlay || document.body
        )}
      </div>
    </div>
  );
}
