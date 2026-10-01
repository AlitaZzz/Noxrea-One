/**
 * 资产库顶部工具条。
 * 右侧依次为：可向左展开的搜索图标、多选模式开关、筛选下拉（多选分类）、新建下拉。
 */

"use client";

import {
  FolderAddOutlined,
  PlusOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import AppCheckbox from "@/components/ui/AppCheckbox";
import AppDropdown from "@/components/ui/AppDropdown";
import AppInput, { type AppInputHandle } from "@/components/ui/AppInput";
import AppPopover from "@/components/ui/AppPopover";
import AppTooltip from "@/components/ui/AppTooltip";
import FilterIcon from "@/components/ui/icons/common/FilterIcon";
import ManageIcon from "@/components/ui/icons/common/ManageIcon";
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
  /** 多选模式：卡片勾选框常驻、卡片点击变为增减选择；按钮同步高亮。 */
  multiSelect?: boolean;
  onToggleMultiSelect?: () => void;
}

const SEARCH_WIDTH = 260;
const ICON_WIDTH = 36;

export default function AssetToolbar({
  search, onSearchChange, categories, onCategoriesChange,
  onUpload, onCreateFolder, canCreateFolder = true,
  multiSelect = false, onToggleMultiSelect,
}: Props) {
  const { t } = useTranslation();

  // 搜索默认收起为一颗图标，点击后输入框向左展开；失焦且内容为空时自动收回。
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<AppInputHandle>(null);
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

  const filterContent = (
    <div className="panel-popover asset-filter-popover">
      <div style={{ padding: "2px 12px 4px", fontSize: 12, color: "var(--canvas-text-muted)" }}>
        {t("asset.filter")}
      </div>
      {ASSET_CATEGORIES.filter(
        (category): category is typeof category & { key: AssetType } => category.key !== "all",
      ).map((cat) => (
        <label key={cat.key} className="filter-row">
          <AppCheckbox
            checked={categories.includes(cat.key)}
            onChange={(checked) => {
              onCategoriesChange(
                checked
                  ? [...categories, cat.key]
                  : categories.filter((k) => k !== cat.key),
              );
            }}
          >
            {t(cat.labelKey)}
          </AppCheckbox>
        </label>
      ))}
      {categories.length > 0 && (
        <>
          <div className="panel-divider" />
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
      {/* 搜索：收起态仅图标，展开态图标固定在右端、输入框向左生长 */}
      <div className="relative shrink-0 transition-[width] duration-200 ease-out" style={{ width: searchExpanded ? SEARCH_WIDTH : ICON_WIDTH, height: ICON_WIDTH }}>
        {searchExpanded && (
          <AppInput
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
        <AppTooltip title={t("asset.search")}>
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
        </AppTooltip>
      </div>

      {/* 管理 / 多选模式：开启后卡片勾选框常驻、单击卡片直接增减选择（≥2 项弹出批量操作条） */}
      <AppTooltip title={multiSelect ? t("asset.exitManage") : t("asset.manage")}>
        <button
          type="button"
          className={`app-icon-btn app-icon-btn--md${multiSelect ? " is-active" : ""}`}
          aria-label={t("asset.manage")}
          aria-pressed={multiSelect}
          onClick={onToggleMultiSelect}
          style={{ color: "#fff" }}
        >
          <ManageIcon style={{ fontSize: 18 }} />
        </button>
      </AppTooltip>

      {/* 筛选：多选分类，选中任一分类后按钮常驻高亮 */}
      <AppPopover
        trigger="click"
        placement="bottomRight"
        contentStyle={{ padding: 0, background: "transparent" }}
        content={filterContent}
      >
        <AppTooltip title={t("asset.filter")}>
          <button
            type="button"
            className={`app-icon-btn app-icon-btn--md${categories.length > 0 ? " is-active" : ""}`}
            aria-label={t("asset.filter")}
            style={{ color: "#fff", fontSize: 18 }}
          >
            <FilterIcon />
          </button>
        </AppTooltip>
      </AppPopover>

      {/* 新建菜单悬停触发，禁用项由 UI 出口处理。 */}
      <AppDropdown
        trigger={["hover"]}
        placement="bottomRight"
        closeDelay={0.15}
        menu={{
          items: [
            { key: "createFolder", icon: <FolderAddOutlined />, label: t("asset.createFolder"), disabled: !canCreateFolder },
            { key: "upload", icon: <UploadOutlined />, label: t("asset.uploadTitle") },
          ],
          onClick: ({ key }) => {
            if (key === "createFolder") onCreateFolder?.();
            else if (key === "upload") onUpload?.();
          },
        }}
      >
        <AppButton variant="primary">
          <PlusOutlined />
          {t("asset.create")}
        </AppButton>
      </AppDropdown>
    </div>
  );
}
