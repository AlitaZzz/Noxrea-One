/**
 * 预设目录菜单内容：按目录分组渲染「分组标题 + 图标两行条目」。
 * 节点工具条「创作」菜单与生成面板「预设」菜单共用；目录按 target 过滤后传入，
 * 仅含 kind === "preset" 的可选条目。
 * 列归属由目录数据的 group.column 声明（从 1 起连续列号）：同列分组纵向堆叠，
 * 列按序从左到右排；单列目录（如文本）保持单列宽度。
 */
"use client";

import { useTranslation } from "react-i18next";

import { localizeText, presetIconOf, type PromptTemplateCatalog } from "./prompt-presets";

interface Props {
  catalog: PromptTemplateCatalog | undefined;
  onSelect: (presetId: string) => void;
}

export default function PresetMenuContent({ catalog, onSelect }: Props) {
  const { i18n } = useTranslation();
  const groups = (catalog?.groups ?? []).filter((group) =>
    (catalog?.entries ?? []).some((entry) => entry.group === group.id)
  );
  const entries = catalog?.entries ?? [];
  const columnNumbers = [...new Set(groups.map((group) => group.column))].sort((a, b) => a - b);
  const columns = columnNumbers.map((column) => groups.filter((group) => group.column === column));
  return (
    <div className={`preset-menu-columns${columns.length > 1 ? " multi" : ""}`}>
      {columns.map((column) => (
        <div key={column.map((group) => group.id).join("|")} className="preset-menu-col">
          {column.map((group) => (
            <div key={group.id}>
              <div className="menu-group-label">{localizeText(group.label, i18n.language)}</div>
              {entries
                .filter((entry) => entry.group === group.id)
                .map((entry) => {
                  const Icon = presetIconOf(entry.id);
                  return (
                    <button key={entry.id} type="button" className="panel-item-btn" onClick={() => onSelect(entry.id)}>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4 shrink-0" />
                        <span className="flex flex-col leading-tight">
                          <span>{localizeText(entry.label, i18n.language)}</span>
                          <span className="menu-item-description">{localizeText(entry.description, i18n.language)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
