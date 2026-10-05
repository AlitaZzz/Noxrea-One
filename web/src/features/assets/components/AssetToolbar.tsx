/**
 * 资产库顶部工具条。
 * 右侧依次为：可向左展开的搜索图标、多选模式开关、筛选下拉（多选分类）、新建下拉。
 */

"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  FolderAddOutlined,
  PlusOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@/components/ui/AppIcon";
import { FilterIcon } from "@/components/ui/AppIcon";
import { ManageIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupClearButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const inputRef = useRef<HTMLInputElement>(null);
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
    <>
      <DropdownMenuLabel>{t("asset.filter")}</DropdownMenuLabel>
      {ASSET_CATEGORIES.filter(
        (category): category is typeof category & { key: AssetType } => category.key !== "all",
      ).map((cat) => (
        <DropdownMenuCheckboxItem
          key={cat.key}
          checked={categories.includes(cat.key)}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) => {
            onCategoriesChange(
              checked
                ? [...categories, cat.key]
                : categories.filter((k) => k !== cat.key),
            );
          }}
        >
          {t(cat.labelKey)}
        </DropdownMenuCheckboxItem>
      ))}
      {categories.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onCategoriesChange([])}>
            {t("asset.filterClear")}
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* 搜索：收起态仅图标，展开态输入组和触发按钮各占独立空间，避免清除按钮与搜索按钮重叠。 */}
      <div className="flex h-9 shrink-0 items-center transition-[width] duration-200 ease-out" style={{ width: searchExpanded ? SEARCH_WIDTH : ICON_WIDTH }}>
        {searchExpanded && (
          <InputGroup
            className="min-w-0 flex-1 bg-popover text-foreground"
          >
            <InputGroupInput
              ref={inputRef}
              placeholder={t("asset.search")}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onBlur={() => { if (!search.trim()) setSearchOpen(false); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { onSearchChange(""); setSearchOpen(false); }
              }}
              className="h-full"
            />
            {search && <InputGroupClearButton onClear={() => onSearchChange("")} />}
          </InputGroup>
        )}
        <Tooltip><TooltipTrigger asChild>
            <Button
              type="button"
              // 阻止按下时输入框失焦：否则空内容会先自动收回、click 又展开，宽度抖一下
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleSearch}
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={t("asset.search")}
            >
              <SearchOutlined />
            </Button>
          </TooltipTrigger><TooltipContent>{t("asset.search")}</TooltipContent></Tooltip>
      </div>

      {/* 管理 / 多选模式：开启后卡片勾选框常驻、单击卡片直接增减选择（≥2 项弹出批量操作条） */}
      <Tooltip><TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="aria-pressed:bg-accent aria-pressed:text-foreground"
            aria-label={t("asset.manage")}
            aria-pressed={multiSelect}
            onClick={onToggleMultiSelect}
          >
            <ManageIcon />
          </Button>
        </TooltipTrigger><TooltipContent>{multiSelect ? t("asset.exitManage") : t("asset.manage")}</TooltipContent></Tooltip>

      {/* 筛选：多选分类，选中任一分类后按钮常驻高亮 */}
      <DropdownMenu>
        <Tooltip><TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-pressed={categories.length > 0}
                className={categories.length > 0 ? "bg-muted text-foreground" : undefined}
              >
                <FilterIcon />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger><TooltipContent>{t("asset.filter")}</TooltipContent></Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          {filterContent}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 新建菜单由 DropdownMenu 点击触发，禁用项由 UI 出口处理。 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="default">
            <PlusOutlined />
            {t("asset.create")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          <DropdownMenuItem disabled={!canCreateFolder} onSelect={onCreateFolder}>
            <FolderAddOutlined />
            {t("asset.createFolder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onUpload}>
            <UploadOutlined />
            {t("asset.uploadTitle")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
