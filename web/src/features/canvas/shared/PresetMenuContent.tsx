/**
 * 预设目录菜单内容：按目录分组渲染「分组标题 + 图标两行条目」。
 * 节点工具条「创作」菜单与生成面板「预设」菜单共用；目录按 target 过滤后传入，
 * 仅含 kind === "preset" 的可选条目。
 */
"use client";

import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { MenuItem } from "@/components/ui/MenuPopover";

import { localizeText, presetIconOf, type PromptTemplateCatalog } from "./prompt-presets";

interface Props {
  catalog: PromptTemplateCatalog | undefined;
  onSelect: (presetId: string) => void;
}

export default function PresetMenuContent({ catalog, onSelect }: Props) {
  const { i18n } = useTranslation();
  const groups = catalog?.groups ?? [];
  const entries = catalog?.entries ?? [];
  return (
    <>
      {groups
        .filter((group) => entries.some((entry) => entry.group === group.id))
        .map((group) => (
          <Fragment key={group.id}>
            <div className="menu-group-label">{localizeText(group.label, i18n.language)}</div>
            {entries
              .filter((entry) => entry.group === group.id)
              .map((entry) => {
                const Icon = presetIconOf(entry.id);
                return (
                  <MenuItem key={entry.id} onClick={() => onSelect(entry.id)}>
                    <span className="flex items-center gap-2">
                      <Icon className="size-4 shrink-0" />
                      <span className="flex flex-col leading-tight">
                        <span>{localizeText(entry.label, i18n.language)}</span>
                        <span className="menu-item-description">{localizeText(entry.description, i18n.language)}</span>
                      </span>
                    </span>
                  </MenuItem>
                );
              })}
          </Fragment>
        ))}
    </>
  );
}
